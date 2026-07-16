/**
 * Bilibili Video Summary — M3.3 subtitle-first acquisition with local ASR.
 *
 * The handler prefers platform subtitles, but public videos without subtitles
 * fall back to a bounded yt-dlp -> ffmpeg -> whisper.cpp pipeline. Every child
 * process receives an argument array (never a shell string), temporary media is
 * deleted after transcription, and Atlas receives only bounded provenance plus
 * external transcript/summary ArtifactRefs.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
  ArtifactRefCreate,
  HandlerResult,
  ResourceGenerator,
  RunRecord,
} from "../work";

// ─── Configuration ───────────────────────────────────────────────────

/** Root of the bilibili-video-summary skill directory (project-root/skills/bilibili-video-summary). */
const SKILL_DIR = join(__dirname, "..", "..", "..", "skills", "bilibili-video-summary");

/** Browser to extract cookies from. */
const COOKIE_BROWSER = process.env.BILIBILI_COOKIE_BROWSER ?? "dia";

const DEFAULT_ASR_MAX_DURATION_SECONDS = 2 * 60 * 60;
const SUBTITLE_TIMEOUT_MS = 120_000;
const MEDIA_PROBE_TIMEOUT_MS = 120_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const AUDIO_CONVERSION_TIMEOUT_MS = 30 * 60_000;
const ASR_TIMEOUT_MS = 2 * 60 * 60_000;

/** B站 common headers. */
const BILI_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

// ─── Types ───────────────────────────────────────────────────────────

export interface BilibiliRunInput {
  url: string;
  source_id: string;
  canonical_url?: string;
  lang?: string;
  cookie_browser?: "dia" | "chrome";
}

export interface BilibiliVideoInfo {
  title: string;
  description: string;
  duration_seconds: number | null;
  duration_text: string;
  cover_url: string;
  page_count: number;
}

export type TranscriptAcquisitionMode = "platform_subtitle" | "local_asr";

export interface AcquiredTranscript {
  text: string;
  mode: TranscriptAcquisitionMode;
  language: string;
  generator: ResourceGenerator;
  metadata: Record<string, unknown>;
}

export type BilibiliAcquisitionFailure = {
  status: "failure";
  code: string;
  message: string;
  retryable: boolean;
};

export type BilibiliAcquisitionResult =
  | {
      status: "success";
      info: BilibiliVideoInfo | null;
      transcript: AcquiredTranscript;
    }
  | BilibiliAcquisitionFailure;

export interface BilibiliAcquisitionRequest {
  bvid: string;
  url: string;
  canonicalUrl: string;
  browser: string;
  language: string;
}

export interface PlatformTranscript {
  text: string;
  language: string;
  metadata: Record<string, unknown>;
}

export interface BilibiliAcquisitionDependencies {
  extractCookies: (browser: string, signal?: AbortSignal) => Promise<string | null>;
  fetchVideoInfo: (
    bvid: string,
    cookies: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<BilibiliVideoInfo | null>;
  fetchPlatformTranscript: (
    url: string,
    cookieFile: string | null,
    language: string,
    signal?: AbortSignal,
  ) => Promise<PlatformTranscript | null>;
  runLocalAsr: (
    request: BilibiliAcquisitionRequest,
    info: BilibiliVideoInfo | null,
    cookieFile: string | null,
    signal?: AbortSignal,
  ) => Promise<BilibiliAcquisitionResult>;
}

export type BilibiliTranscriptAcquirer = (
  request: BilibiliAcquisitionRequest,
  signal: AbortSignal,
) => Promise<BilibiliAcquisitionResult>;

/** Output stored in run output (bounded: no transcript text). */
export interface BilibiliRunOutput {
  bvid: string;
  url: string;
  title: string;
  description: string;
  duration_seconds: number | null;
  duration_text: string;
  cover_url: string;
  page_count: number;
  transcript_length: number;
  transcript_acquisition_mode: TranscriptAcquisitionMode;
  transcript_language: string;
  asr_engine?: string;
  asr_model?: string;
  /** 0 = no transcript; 1 = transcript fetched; 2 = transcript + AI summary */
  processing_level: number;
}

export interface BilibiliSummaryRequest {
  bvid: string;
  url: string;
  title: string;
  description: string;
  transcript: string;
}

export interface BilibiliSummaryResult {
  markdown: string;
  generator: ResourceGenerator;
  metadata: Record<string, unknown>;
}

export type BilibiliSummaryGenerator = (
  request: BilibiliSummaryRequest,
  signal: AbortSignal,
) => Promise<BilibiliSummaryResult>;

// ─── Helpers ─────────────────────────────────────────────────────────

interface CommandResult {
  stdout: string;
  stderr: string;
}

class CommandExecutionError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: string | number | null,
    readonly causeCode: string | null,
    readonly timedOut: boolean,
  ) {
    super(
      `${command} failed${timedOut ? " after timeout" : ""}`
      + (exitCode === null || exitCode === undefined ? "" : ` (exit ${exitCode})`),
    );
    this.name = "CommandExecutionError";
  }
}

/** Child tools need paths and locale, not Atlas/model-provider credentials. */
function subprocessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  for (const key of Object.keys(env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/** Execute one binary directly with bounded output and abort-aware termination. */
function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    maxBuffer?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let child: ReturnType<typeof execFile> | null = null;
    const onAbort = () => {
      child?.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child?.exitCode === null) child.kill("SIGKILL");
      }, 5_000);
      if ("unref" in forceKillTimer) forceKillTimer.unref();
    };

    child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf-8",
        timeout: options.timeoutMs,
        env: subprocessEnvironment(),
        shell: false,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        if (err) {
          const error = err as NodeJS.ErrnoException & { killed?: boolean };
          reject(new CommandExecutionError(
            command,
            error.code ?? null,
            typeof error.code === "string" ? error.code : null,
            Boolean(error.killed && !options.signal?.aborted),
          ));
        } else {
          resolve({ stdout: stdout || "", stderr: stderr || "" });
        }
      },
    );

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/** Run a Python script under uv with the skill venv, without shell interpretation. */
function uvRun(
  script: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  return runCommand("uv", ["run", "python", script, ...args], {
    cwd: SKILL_DIR,
    signal,
    timeoutMs: SUBTITLE_TIMEOUT_MS,
  });
}

/**
 * Step 1: Extract B站 cookies from browser profile.
 * Returns path to Netscape-format cookie file.
 */
async function extractCookies(
  browser: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cookieFile = join(tmpdir(), `bilibili_cookies_${randomUUID().slice(0, 8)}.txt`);

  try {
    await uvRun(join(SKILL_DIR, "scripts", "extract_cookies.py"), [
      "-b", browser,
      "-o", cookieFile,
    ], signal);
    return cookieFile;
  } catch (error) {
    if (signal?.aborted) throw error;
    try { unlinkSync(cookieFile); } catch { /* absent */ }
    return null;
  }
}

/** Parse a Netscape-format cookie file into key → value. */
function parseCookies(cookieFile: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  try {
    for (const line of readFileSync(cookieFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split("\t");
      if (parts.length >= 7) cookies[parts[5]] = parts[6];
    }
  } catch { /* empty */ }
  return cookies;
}

/** Build a Cookie header string from cookie map. */
function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Step 2: Fetch video metadata from B站 view API.
 */
async function fetchVideoInfo(
  bvid: string,
  cookies: Record<string, string>,
  signal?: AbortSignal,
): Promise<BilibiliVideoInfo | null> {
  try {
    const headers: Record<string, string> = { ...BILI_HEADERS };
    const cookie = cookieHeader(cookies);
    if (cookie) headers.Cookie = cookie;
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers,
      signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json() as any;
    const data = json?.data;
    if (!data) return null;
    const durationSeconds = Number.isFinite(Number(data.duration))
      ? Number(data.duration)
      : null;
    return {
      title: data.title ?? "",
      description: data.desc ?? "",
      duration_seconds: durationSeconds,
      duration_text: formatDuration(durationSeconds),
      cover_url: data.pic ?? "",
      page_count: data.pages?.length ?? 1,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Step 3: Fetch a platform subtitle transcript using fetch_subtitle.py.
 * Empty output means the platform has no usable subtitle and activates ASR.
 */
async function fetchPlatformTranscript(
  url: string,
  cookieFile: string | null,
  lang: string,
  signal?: AbortSignal,
): Promise<PlatformTranscript | null> {
  const outFile = join(tmpdir(), `bili_transcript_${randomUUID().slice(0, 8)}.txt`);
  const statusFile = join(tmpdir(), `bili_transcript_status_${randomUUID().slice(0, 8)}.json`);

  try {
    const args = [
      url,
      "-l", lang,
      "--no-timestamps",
      "--no-desc",
      "-o", outFile,
      "--status-output", statusFile,
    ];
    if (cookieFile) args.push("-c", cookieFile);
    await uvRun(join(SKILL_DIR, "scripts", "fetch_subtitle.py"), args, signal);

    if (!existsSync(outFile)) return null;
    const text = readFileSync(outFile, "utf-8").trim();
    if (!text) return null;

    let status: Record<string, unknown> = {};
    try {
      status = JSON.parse(readFileSync(statusFile, "utf-8")) as Record<string, unknown>;
    } catch { /* status metadata is optional */ }
    const selectedLanguages = Array.isArray(status.selected_languages)
      ? status.selected_languages.filter((value): value is string => typeof value === "string")
      : [];
    return {
      text,
      language: selectedLanguages.join(",") || lang,
      metadata: {
        acquisition_mode: "platform_subtitle",
        requested_language: lang,
        selected_languages: selectedLanguages,
        part_count: status.part_count ?? 1,
        cids: status.cids ?? [],
        authenticated: status.authenticated === true,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    try { unlinkSync(outFile); } catch { /* absent */ }
    try { unlinkSync(statusFile); } catch { /* absent */ }
  }
}

function asrModelPath(): string {
  const configured = process.env.BILIBILI_ASR_MODEL?.trim();
  if (!configured) {
    return join(homedir(), "Library", "Caches", "Lumio", "asr", "whisper", "ggml-small.bin");
  }
  return configured.startsWith("~/")
    ? join(homedir(), configured.slice(2))
    : configured;
}

function configuredBinary(variable: string, fallback: string): string {
  return process.env[variable]?.trim() || fallback;
}

function maxAsrDurationSeconds(): number {
  const configured = Number(process.env.BILIBILI_ASR_MAX_DURATION_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_ASR_MAX_DURATION_SECONDS;
}

function asrLanguage(language: string): string {
  const normalized = language.replace(/^ai-/, "").trim().toLowerCase();
  if (normalized.startsWith("zh")) return "zh";
  return normalized || "auto";
}

function cookieArguments(cookieFile: string | null): string[] {
  return cookieFile ? ["--cookies", cookieFile] : [];
}

function commandFailure(
  error: unknown,
  stage: string,
  missingCode: string,
  failureCode: string,
  retryable: boolean,
): BilibiliAcquisitionFailure {
  if (error instanceof CommandExecutionError && error.causeCode === "ENOENT") {
    return {
      status: "failure",
      code: missingCode,
      message: `${stage} is not installed or is not available on PATH.`,
      retryable: false,
    };
  }
  const detail = error instanceof CommandExecutionError
    ? error.message
    : `${stage} failed`;
  return {
    status: "failure",
    code: failureCode,
    message: `${stage} failed: ${detail}`.slice(0, 500),
    retryable,
  };
}

function parseWhisperTranscript(path: string): { text: string; language: string | null } {
  const document = JSON.parse(readFileSync(path, "utf-8")) as {
    result?: { language?: unknown };
    transcription?: Array<{ text?: unknown }>;
    text?: unknown;
  };
  const segmentText = Array.isArray(document.transcription)
    ? document.transcription
      .map((segment) => typeof segment.text === "string" ? segment.text.trim() : "")
      .filter(Boolean)
      .join("\n")
    : "";
  const text = segmentText || (typeof document.text === "string" ? document.text.trim() : "");
  return {
    text,
    language: typeof document.result?.language === "string"
      ? document.result.language
      : null,
  };
}

/**
 * Download one audio stream, normalize it to 16 kHz mono PCM, and transcribe it
 * locally with whisper.cpp. Raw media is never retained as an Atlas artifact.
 */
export async function runLocalAsr(
  request: BilibiliAcquisitionRequest,
  info: BilibiliVideoInfo | null,
  cookieFile: string | null,
  signal?: AbortSignal,
): Promise<BilibiliAcquisitionResult> {
  if ((info?.page_count ?? 1) > 1) {
    return {
      status: "failure",
      code: "multipart_asr_unsupported",
      message: `Local ASR does not yet support all ${info?.page_count} parts of ${request.bvid}.`,
      retryable: false,
    };
  }

  const modelPath = asrModelPath();
  if (!existsSync(modelPath)) {
    return {
      status: "failure",
      code: "asr_not_configured",
      message: `Local ASR model is missing. Run whisper-cpp-download-ggml-model small, then place it at the configured BILIBILI_ASR_MODEL path.`,
      retryable: false,
    };
  }

  const ytDlp = configuredBinary("BILIBILI_YT_DLP_BIN", "yt-dlp");
  const ffmpeg = configuredBinary("BILIBILI_FFMPEG_BIN", "ffmpeg");
  const whisper = configuredBinary("BILIBILI_WHISPER_BIN", "whisper-cli");
  const durationLimit = maxAsrDurationSeconds();
  const workDir = mkdtempSync(join(tmpdir(), `lumio-bili-asr-${request.bvid}-`));

  try {
    let durationSeconds = info?.duration_seconds ?? null;
    if (!durationSeconds || durationSeconds <= 0) {
      let probe: CommandResult;
      try {
        probe = await runCommand(ytDlp, [
          "--no-playlist",
          "--skip-download",
          "--no-warnings",
          "--dump-single-json",
          ...cookieArguments(cookieFile),
          request.canonicalUrl,
        ], {
          signal,
          timeoutMs: MEDIA_PROBE_TIMEOUT_MS,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return commandFailure(
          error,
          "yt-dlp media probe",
          "asr_not_configured",
          "media_probe_failed",
          true,
        );
      }
      try {
        const mediaInfo = JSON.parse(probe.stdout) as { duration?: unknown };
        const probedDuration = Number(mediaInfo.duration);
        durationSeconds = Number.isFinite(probedDuration) && probedDuration > 0
          ? probedDuration
          : null;
      } catch {
        durationSeconds = null;
      }
    }

    if (!durationSeconds) {
      return {
        status: "failure",
        code: "media_duration_unknown",
        message: `Cannot determine the duration of ${request.bvid}; refusing an unbounded ASR run.`,
        retryable: false,
      };
    }
    if (durationSeconds > durationLimit) {
      return {
        status: "failure",
        code: "media_too_long",
        message: `${request.bvid} is ${Math.ceil(durationSeconds)}s, above the local ASR limit of ${durationLimit}s.`,
        retryable: false,
      };
    }

    const outputTemplate = join(workDir, "source.%(ext)s");
    let download: CommandResult;
    try {
      download = await runCommand(ytDlp, [
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "--format", "bestaudio/best",
        "--output", outputTemplate,
        "--print", "after_move:%(filepath)s",
        ...cookieArguments(cookieFile),
        request.canonicalUrl,
      ], {
        signal,
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return commandFailure(
        error,
        "yt-dlp audio download",
        "asr_not_configured",
        "audio_download_failed",
        true,
      );
    }

    const audioPath = download.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((candidate) => existsSync(candidate));
    if (!audioPath) {
      return {
        status: "failure",
        code: "audio_download_failed",
        message: `yt-dlp did not report a downloaded audio file for ${request.bvid}.`,
        retryable: true,
      };
    }
    const resolvedAudioPath = resolve(audioPath);
    if (!resolvedAudioPath.startsWith(`${resolve(workDir)}${sep}`)) {
      return {
        status: "failure",
        code: "unsafe_media_path",
        message: "yt-dlp reported an audio path outside the task temporary directory.",
        retryable: false,
      };
    }

    const wavPath = join(workDir, "audio.wav");
    try {
      await runCommand(ffmpeg, [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", resolvedAudioPath,
        "-vn",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        wavPath,
      ], {
        signal,
        timeoutMs: AUDIO_CONVERSION_TIMEOUT_MS,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return commandFailure(
        error,
        "ffmpeg audio conversion",
        "asr_not_configured",
        "audio_conversion_failed",
        false,
      );
    }

    const outputBase = join(workDir, "transcript");
    try {
      await runCommand(whisper, [
        "-m", modelPath,
        "-f", wavPath,
        "-l", asrLanguage(request.language),
        "-oj",
        "-of", outputBase,
        "-np",
      ], {
        signal,
        timeoutMs: ASR_TIMEOUT_MS,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return commandFailure(
        error,
        "whisper.cpp transcription",
        "asr_not_configured",
        "asr_failed",
        false,
      );
    }

    const jsonPath = `${outputBase}.json`;
    if (!existsSync(jsonPath)) {
      return {
        status: "failure",
        code: "asr_failed",
        message: `whisper.cpp did not create JSON output for ${request.bvid}.`,
        retryable: false,
      };
    }
    let parsed: { text: string; language: string | null };
    try {
      parsed = parseWhisperTranscript(jsonPath);
    } catch {
      return {
        status: "failure",
        code: "asr_failed",
        message: `whisper.cpp returned invalid JSON for ${request.bvid}.`,
        retryable: false,
      };
    }
    if (!parsed.text.trim()) {
      return {
        status: "failure",
        code: "empty_asr_transcript",
        message: `Local ASR produced an empty transcript for ${request.bvid}.`,
        retryable: false,
      };
    }

    const modelName = basename(modelPath)
      .replace(/^ggml-/, "")
      .replace(/\.bin$/, "");
    return {
      status: "success",
      info,
      transcript: {
        text: parsed.text.trim(),
        mode: "local_asr",
        language: parsed.language || asrLanguage(request.language),
        generator: {
          mode: "ai",
          name: "whisper.cpp",
          version: "1",
        },
        metadata: {
          acquisition_mode: "local_asr",
          language: parsed.language || asrLanguage(request.language),
          asr_engine: "whisper.cpp",
          asr_model: modelName,
          duration_seconds: durationSeconds,
          audio_normalization: "pcm_s16le/16000Hz/mono",
          retained_media: false,
        },
      },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const DEFAULT_ACQUISITION_DEPENDENCIES: BilibiliAcquisitionDependencies = {
  extractCookies,
  fetchVideoInfo,
  fetchPlatformTranscript,
  runLocalAsr,
};

/** Prefer platform subtitles, then fall back to bounded local ASR. */
export async function acquireBilibiliTranscript(
  request: BilibiliAcquisitionRequest,
  signal: AbortSignal,
  dependencies: Partial<BilibiliAcquisitionDependencies> = {},
): Promise<BilibiliAcquisitionResult> {
  const deps = { ...DEFAULT_ACQUISITION_DEPENDENCIES, ...dependencies };
  let cookieFile: string | null = null;
  try {
    cookieFile = await deps.extractCookies(request.browser, signal);
    const cookies = cookieFile ? parseCookies(cookieFile) : {};
    const info = await deps.fetchVideoInfo(request.bvid, cookies, signal);
    const platform = await deps.fetchPlatformTranscript(
      request.url,
      cookieFile,
      request.language,
      signal,
    );
    if (platform?.text.trim()) {
      return {
        status: "success",
        info,
        transcript: {
          text: platform.text.trim(),
          mode: "platform_subtitle",
          language: platform.language,
          generator: {
            mode: "deterministic",
            name: "lumio-bilibili-platform-subtitle",
            version: "2",
          },
          metadata: platform.metadata,
        },
      };
    }
    return await deps.runLocalAsr(request, info, cookieFile, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: "failure",
      code: "transcript_acquisition_failed",
      message: `Transcript acquisition failed for ${request.bvid}.`,
      retryable: true,
    };
  } finally {
    cleanup(cookieFile);
  }
}

function artifactRoot(): string {
  const root = process.env.ATLAS_ARTIFACT_ROOT?.trim();
  if (!root) {
    throw new Error("ATLAS_ARTIFACT_ROOT must be configured for content storage");
  }
  return root;
}

function storeTextArtifact(
  content: string,
  directory: string,
  bvid: string,
  name: string,
  extension: ".txt" | ".md",
  contentType: string,
): ArtifactRefCreate {
  const hash = createHash("sha256").update(content).digest("hex");
  const dir = join(artifactRoot(), directory, bvid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const destPath = join(dir, `${hash.slice(0, 16)}${extension}`);
  if (!existsSync(destPath)) {
    const tempPath = join(dir, `.${hash.slice(0, 16)}.${randomUUID()}${extension}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tempPath, "wx", 0o600);
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, destPath);
    } finally {
      if (fd !== null) closeSync(fd);
      try { unlinkSync(tempPath); } catch { /* already renamed or absent */ }
    }
  } else {
    const existingHash = createHash("sha256")
      .update(readFileSync(destPath))
      .digest("hex");
    if (existingHash !== hash) {
      throw new Error(`Artifact hash collision at ${destPath}`);
    }
  }

  const uri = `file://${destPath}`;
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  return {
    name,
    uri,
    content_type: contentType,
    size_bytes: sizeBytes,
    checksum: `sha256:${hash}`,
  };
}

/** Persist a fetched transcript as a content-addressed external ArtifactRef. */
export function storeTranscriptArtifact(
  transcriptPath: string,
  bvid: string,
): ArtifactRefCreate {
  return storeTranscriptTextArtifact(readFileSync(transcriptPath, "utf-8"), bvid);
}

/** Persist transcript text without retaining the temporary acquisition file. */
export function storeTranscriptTextArtifact(
  transcript: string,
  bvid: string,
): ArtifactRefCreate {
  return storeTextArtifact(
    transcript,
    "transcripts",
    bvid,
    `transcript-${bvid}`,
    ".txt",
    "text/plain; charset=utf-8",
  );
}

/** Persist an AI summary as a content-addressed Markdown ArtifactRef. */
export function storeSummaryArtifact(markdown: string, bvid: string): ArtifactRefCreate {
  return storeTextArtifact(
    markdown,
    join("resources", "bilibili"),
    bvid,
    `summary-${bvid}`,
    ".md",
    "text/markdown; charset=utf-8",
  );
}

/** Stable Resource identity for one Source, kind, and immutable content hash. */
export function createResourceId(
  sourceId: string,
  kind: "transcript" | "summary",
  contentHash: string,
): string {
  const digest = createHash("sha256")
    .update(`${sourceId}\0${kind}\0${contentHash}`)
    .digest("hex");
  return `res_${digest.slice(0, 32)}`;
}

/**
 * Tear-down: delete cookie file (contains sensitive SESSDATA).
 */
function cleanup(cookieFile: string | null) {
  if (cookieFile) {
    try { unlinkSync(cookieFile); } catch { /* ignore */ }
  }
}

// ─── Main Handler ────────────────────────────────────────────────────

/**
 * Bilibili summary job handler.
 *
 * Receives a claimed RunRecord, executes the full pipeline,
 * and returns a typed HandlerResult per RFC 0002.
 */
export async function bilibiliSummaryHandler(
  run: RunRecord,
  signal: AbortSignal,
  summarize?: BilibiliSummaryGenerator,
  acquire: BilibiliTranscriptAcquirer = acquireBilibiliTranscript,
): Promise<HandlerResult> {
  const input = run.input as unknown as BilibiliRunInput;
  const url = input?.url;
  if (!url) {
    return {
      status: "failure",
      code: "invalid_input",
      message: "Missing required field: url",
      retryable: false,
    };
  }
  const sourceId = input?.source_id?.trim();
  if (!sourceId) {
    return {
      status: "failure",
      code: "invalid_input",
      message: "Missing required field: source_id",
      retryable: false,
    };
  }
  if (!summarize) {
    return {
      status: "failure",
      code: "summary_model_unavailable",
      message: "No Pi summary model is available for this session.",
      retryable: true,
    };
  }

  const browser = input.cookie_browser ?? COOKIE_BROWSER;
  const lang = input.lang ?? "ai-zh";

  // Parse BV ID for early validation.
  const bvid = extractBvid(url);
  if (!bvid) {
    return {
      status: "failure",
      code: "invalid_input",
      message: `Cannot extract BV号 from URL: ${url}`,
      retryable: false,
    };
  }

  const canonicalUrl = input.canonical_url?.trim()
    || `https://www.bilibili.com/video/${bvid}`;
  const acquisition = await acquire({
    bvid,
    url,
    canonicalUrl,
    browser,
    language: lang,
  }, signal);
  if (acquisition.status === "failure") return acquisition;

  const { info, transcript: acquiredTranscript } = acquisition;
  const transcript = acquiredTranscript.text.trim();
  if (!transcript) {
    return {
      status: "failure",
      code: "empty_transcript",
      message: `Transcript for ${bvid} is empty`,
      retryable: false,
    };
  }
  const transcriptArtifact = storeTranscriptTextArtifact(`${transcript}\n`, bvid);
  const title = boundedText(info?.title || bvid, 1000);
  const description = boundedText(info?.description ?? "", 5000);

  let summary: BilibiliSummaryResult;
  try {
    summary = await summarize({
      bvid,
      url: canonicalUrl,
      title,
      description,
      transcript,
    }, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failure",
      code: "summary_failed",
      message: `AI summary failed for ${bvid}: ${message.slice(0, 500)}`,
      retryable: true,
    };
  }

  const summaryMarkdown = summary.markdown.trim();
  if (!summaryMarkdown) {
    return {
      status: "failure",
      code: "empty_summary",
      message: `AI model returned an empty summary for ${bvid}`,
      retryable: true,
    };
  }
  const summaryArtifact = storeSummaryArtifact(`${summaryMarkdown}\n`, bvid);
  const transcriptHash = requiredChecksum(transcriptArtifact);
  const summaryHash = requiredChecksum(summaryArtifact);
  const transcriptResourceId = createResourceId(sourceId, "transcript", transcriptHash);
  const asrEngine = typeof acquiredTranscript.metadata.asr_engine === "string"
    ? acquiredTranscript.metadata.asr_engine
    : undefined;
  const asrModel = typeof acquiredTranscript.metadata.asr_model === "string"
    ? acquiredTranscript.metadata.asr_model
    : undefined;

  // Bounded output only: transcript and summary bodies remain external artifacts.
  const output: BilibiliRunOutput = {
    bvid,
    url: canonicalUrl,
    title,
    description,
    duration_seconds: info?.duration_seconds ?? null,
    duration_text: info?.duration_text ?? "",
    cover_url: info?.cover_url ?? "",
    page_count: info?.page_count ?? 1,
    transcript_length: transcriptArtifact.size_bytes ?? Buffer.byteLength(transcript),
    transcript_acquisition_mode: acquiredTranscript.mode,
    transcript_language: acquiredTranscript.language,
    ...(asrEngine ? { asr_engine: asrEngine } : {}),
    ...(asrModel ? { asr_model: asrModel } : {}),
    processing_level: 2,
  };

  return {
    status: "success",
    output: output as unknown as Record<string, unknown>,
    artifacts: [transcriptArtifact, summaryArtifact],
    source_updates: [{
      source_id: sourceId,
      canonical_uri: canonicalUrl,
      title,
      external_ids: { bvid },
      metadata: {
        description,
        duration_seconds: info?.duration_seconds ?? null,
        duration_text: info?.duration_text ?? "",
        cover_url: info?.cover_url ?? "",
        page_count: info?.page_count ?? 1,
        transcript_acquisition_mode: acquiredTranscript.mode,
      },
    }],
    resources: [
      {
        resource_id: transcriptResourceId,
        source_id: sourceId,
        kind: "transcript",
        title: `${title} — transcript`,
        artifact_name: transcriptArtifact.name,
        content_hash: transcriptHash,
        generator: acquiredTranscript.generator,
        metadata: {
          ...acquiredTranscript.metadata,
          acquisition_mode: acquiredTranscript.mode,
          language: acquiredTranscript.language,
        },
      },
      {
        resource_id: createResourceId(sourceId, "summary", summaryHash),
        source_id: sourceId,
        kind: "summary",
        title: `${title} — AI summary`,
        artifact_name: summaryArtifact.name,
        content_hash: summaryHash,
        generator: summary.generator,
        metadata: {
          ...summary.metadata,
          transcript_resource_id: transcriptResourceId,
          transcript_acquisition_mode: acquiredTranscript.mode,
          transcript_language: acquiredTranscript.language,
        },
      },
    ],
  };
}

/** Extract BV号 from a B站 URL. */
function extractBvid(url: string): string | null {
  const m = url.match(/BV[a-zA-Z0-9]{10}/);
  return m ? m[0] : null;
}

function requiredChecksum(artifact: ArtifactRefCreate): string {
  if (!artifact.checksum?.match(/^sha256:[0-9a-f]{64}$/)) {
    throw new Error(`Artifact ${artifact.name} is missing a SHA-256 checksum`);
  }
  return artifact.checksum;
}

function boundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

// ─── Re-export for index.ts ──────────────────────────────────────────

export { extractBvid };
