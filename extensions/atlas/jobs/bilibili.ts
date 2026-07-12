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
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { RunRecord, HandlerResult, ArtifactRefCreate } from "../work";

// ─── Configuration ───────────────────────────────────────────────────

/** Root of the bilibili-video-summary skill directory (project-root/skills/bilibili-video-summary). */
const SKILL_DIR = join(__dirname, "..", "..", "..", "skills", "bilibili-video-summary");

/** Browser to extract cookies from. */
const COOKIE_BROWSER = process.env.BILIBILI_COOKIE_BROWSER ?? "dia";

/** Directory for persistent artifacts (transcripts, summaries). */
const ARTIFACT_ROOT = process.env.ATLAS_ARTIFACT_ROOT?.trim() || null;

/** B站 common headers. */
const BILI_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

// ─── Types ───────────────────────────────────────────────────────────

export interface BilibiliRunInput {
  url: string;
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

/**
 * Persist transcript as an artifact file with a content hash.
 * Returns an ArtifactRefCreate for Atlas.
 */
export function storeTranscriptArtifact(
  transcriptPath: string,
  bvid: string,
): ArtifactRefCreate {
  if (!ARTIFACT_ROOT) {
    throw new Error("ATLAS_ARTIFACT_ROOT must be configured for transcript storage");
  }
  const content = readFileSync(transcriptPath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");

  // Store under artifact root: <root>/atlas/transcripts/<bvid>/<hash>.txt
  const dir = join(ARTIFACT_ROOT, "transcripts", bvid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const destPath = join(dir, `${hash.slice(0, 16)}.txt`);
  if (!existsSync(destPath)) {
    const tempPath = join(dir, `.${hash.slice(0, 16)}.${randomUUID()}.tmp`);
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
    name: `transcript-${bvid}`,
    uri,
    content_type: "text/plain; charset=utf-8",
    size_bytes: sizeBytes,
    checksum: `sha256:${hash}`,
  };
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

    // Step 4: Persist transcript as external artifact.
    let artifacts: ArtifactRefCreate[] = [];
    let transcriptLength = 0;
    let processingLevel = 0;

    if (transcriptPath) {
      try {
        const art = storeTranscriptArtifact(transcriptPath, bvid);
        artifacts.push(art);
        transcriptLength = art.size_bytes ?? 0;
        processingLevel = 1;
      } finally {
        // Always clean up temp transcript file.
        try { unlinkSync(transcriptPath); } catch { /* ignore */ }
      }
    }

    // Check if we got anything useful.
    const gotMetadata = info !== null && (info.title || info.description);
    const gotTranscript = transcriptLength > 0;

    if (!gotMetadata && !gotTranscript) {
      return {
        status: "failure",
        code: "no_content",
        message: `No metadata or transcript extracted for ${bvid}`,
        retryable: false,
      };
    }

    // Build bounded output (no transcript text).
    const output: BilibiliRunOutput = {
      bvid,
      url,
      title: info?.title ?? "",
      description: info?.description ?? "",
      duration_text: info?.duration_text ?? "",
      cover_url: info?.cover_url ?? "",
      page_count: info?.page_count ?? 1,
      transcript_length: transcriptLength,
      processing_level: processingLevel,
    };

    return {
      status: "success",
      output: output as unknown as Record<string, unknown>,
      artifacts,
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

// ─── Re-export for index.ts ──────────────────────────────────────────

export { extractBvid };
