/**
 * Bilibili Video Summary — M3 vertical slice (M2.5 hardened).
 *
 * Job handler that orchestrates the existing Python pipeline
 * (cookie extraction, WBI-signed API calls, subtitle fetching) to
 * produce a structured video summary stored in Atlas.
 *
 * M2.5 hardening:
 *   - Replaced execSync shell-string with async execFile (no shell).
 *   - Transcript text stored as an external artifact file, not in run output.
 *   - Return typed HandlerResult instead of mutating (run as any)._handler_output.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Output stored in run output (bounded: no transcript text). */
export interface BilibiliRunOutput {
  bvid: string;
  url: string;
  title: string;
  description: string;
  duration_text: string;
  cover_url: string;
  page_count: number;
  transcript_length: number;
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

/**
 * Run a Python script under uv with the skill venv.
 * Uses execFile with argument array — no shell interpretation.
 * Accepts AbortSignal to kill child process on cancellation.
 */
function uvRun(
  script: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const allArgs = ["run", "python", script, ...args];
  return new Promise((resolve, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000);
      if ("unref" in forceKillTimer) forceKillTimer.unref();
    };
    const child = execFile(
      "uv",
      allArgs,
      {
        cwd: SKILL_DIR,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        if (err) {
          reject(new Error(`uv run failed (exit ${(err as any).code}): ${stderr || stdout || err.message}`));
        } else {
          resolve({ stdout: stdout || "", stderr: stderr || "" });
        }
      },
    );

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
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
  } catch {
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
): Promise<{
  title: string;
  description: string;
  duration_text: string;
  cover_url: string;
  page_count: number;
} | null> {
  try {
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { ...BILI_HEADERS, Cookie: cookieHeader(cookies) },
      signal,
    });
    if (!resp.ok) return null;
    const json = await resp.json() as any;
    const data = json?.data;
    if (!data) return null;
    return {
      title: data.title ?? "",
      description: data.desc ?? "",
      duration_text: data.duration ?? "",
      cover_url: data.pic ?? "",
      page_count: data.pages?.length ?? 1,
    };
  } catch {
    return null;
  }
}

/**
 * Step 3: Fetch subtitle transcript using fetch_subtitle.py.
 * Returns the transcript file path on success (caller must clean up).
 */
async function fetchTranscript(
  url: string,
  cookieFile: string,
  lang: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const outFile = join(tmpdir(), `bili_transcript_${randomUUID().slice(0, 8)}.txt`);

  try {
    await uvRun(join(SKILL_DIR, "scripts", "fetch_subtitle.py"), [
      url,
      "-c", cookieFile,
      "-l", lang,
      "--no-timestamps",
      "--no-desc",
      "-o", outFile,
    ], signal);

    if (!existsSync(outFile)) return null;
    return outFile;
  } catch {
    return null;
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
  return storeTextArtifact(
    readFileSync(transcriptPath, "utf-8"),
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
): Promise<HandlerResult> {
  const input = run.input as BilibiliRunInput;
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

  // Step 1: Extract cookies.
  const cookieFile = await extractCookies(browser, signal);
  if (!cookieFile) {
    return {
      status: "failure",
      code: "cookie_extraction_failed",
      message: `Failed to extract cookies from ${browser} browser.`,
      retryable: true,
    };
  }

  try {
    const cookies = parseCookies(cookieFile);

    // Step 2: Fetch video metadata.
    const info = await fetchVideoInfo(bvid, cookies, signal);

    // Step 3: Fetch transcript.
    const transcriptPath = await fetchTranscript(url, cookieFile, lang, signal);

    if (!transcriptPath) {
      return {
        status: "failure",
        code: "transcript_unavailable",
        message: `No subtitle transcript is available for ${bvid}`,
        retryable: false,
      };
    }

    let transcript = "";
    let transcriptArtifact: ArtifactRefCreate;
    try {
      transcript = readFileSync(transcriptPath, "utf-8");
      if (!transcript.trim()) {
        return {
          status: "failure",
          code: "empty_transcript",
          message: `Subtitle transcript for ${bvid} is empty`,
          retryable: false,
        };
      }
      transcriptArtifact = storeTranscriptArtifact(transcriptPath, bvid);
    } finally {
      try { unlinkSync(transcriptPath); } catch { /* ignore */ }
    }

    const title = boundedText(info?.title || bvid, 1000);
    const canonicalUrl = input.canonical_url?.trim()
      || `https://www.bilibili.com/video/${bvid}`;

    let summary: BilibiliSummaryResult;
    try {
      summary = await summarize({
        bvid,
        url: canonicalUrl,
        title,
        description: boundedText(info?.description ?? "", 5000),
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

    // Build bounded output (no transcript text).
    const output: BilibiliRunOutput = {
      bvid,
      url: canonicalUrl,
      title,
      description: boundedText(info?.description ?? "", 5000),
      duration_text: info?.duration_text ?? "",
      cover_url: info?.cover_url ?? "",
      page_count: info?.page_count ?? 1,
      transcript_length: transcriptArtifact.size_bytes ?? Buffer.byteLength(transcript),
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
          description: boundedText(info?.description ?? "", 5000),
          duration_text: info?.duration_text ?? "",
          cover_url: info?.cover_url ?? "",
          page_count: info?.page_count ?? 1,
        },
      }],
      resources: [
        {
          resource_id: createResourceId(sourceId, "transcript", transcriptHash),
          source_id: sourceId,
          kind: "transcript",
          title: `${title} — transcript`,
          artifact_name: transcriptArtifact.name,
          content_hash: transcriptHash,
          generator: {
            mode: "deterministic",
            name: "lumio-bilibili-transcript",
            version: "1",
          },
          metadata: { language: lang },
        },
        {
          resource_id: createResourceId(sourceId, "summary", summaryHash),
          source_id: sourceId,
          kind: "summary",
          title: `${title} — AI summary`,
          artifact_name: summaryArtifact.name,
          content_hash: summaryHash,
          generator: summary.generator,
          metadata: summary.metadata,
        },
      ],
    };
  } finally {
    cleanup(cookieFile);
  }
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

// ─── Re-export for index.ts ──────────────────────────────────────────

export { extractBvid };
