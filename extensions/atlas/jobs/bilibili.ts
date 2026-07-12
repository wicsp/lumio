/**
 * Bilibili Video Summary — M3 vertical slice.
 *
 * Job handler that orchestrates the existing Python pipeline
 * (cookie extraction, WBI-signed API calls, subtitle fetching) to
 * produce a structured video summary stored in Atlas.
 *
 * The handler:
 *   1. Extracts B站 cookies from Dia/Chrome browser profile.
 *   2. Fetches video metadata (title, description, stats).
 *   3. Fetches AI subtitle transcript.
 *   4. Stores the result as structured run output in Atlas.
 */

import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "../work";

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
	lang?: string;
	cookie_browser?: "dia" | "chrome";
}

export interface BilibiliRunOutput {
	bvid: string;
	url: string;
	title: string;
	description: string;
	duration_text: string;
	cover_url: string;
	page_count: number;
	transcript_length: number;
	/** Full transcript text (may be truncated in output display, full text in Atlas events). */
	transcript: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Run a Python script under uv with the skill venv, capture stdout. */
function uvRun(script: string, args: string[]): { stdout: string; stderr: string } {
	const cmd = ["uv", "run", "python", script, ...args].map(a =>
		a.includes(" ") ? `"${a}"` : a
	).join(" ");
	const result = execSync(cmd, {
		cwd: SKILL_DIR,
		encoding: "utf-8",
		timeout: 60_000,
		env: { ...process.env, PYTHONUNBUFFERED: "1" },
	});
	return { stdout: result, stderr: "" };
}

/**
 * Step 1: Extract B站 cookies from browser profile.
 * Returns path to Netscape-format cookie file.
 */
function extractCookies(browser: string): string | null {
	const cookieFile = join(tmpdir(), `bilibili_cookies_${randomUUID().slice(0, 8)}.txt`);

	try {
		uvRun(join(SKILL_DIR, "scripts", "extract_cookies.py"), [
			"-b", browser,
			"-o", cookieFile,
		]);
		return cookieFile;
	} catch (err) {
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
async function fetchVideoInfo(bvid: string, cookies: Record<string, string>): Promise<{
	title: string;
	description: string;
	duration_text: string;
	cover_url: string;
	page_count: number;
} | null> {
	try {
		const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
			headers: { ...BILI_HEADERS, Cookie: cookieHeader(cookies) },
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
 */
function fetchTranscript(url: string, cookieFile: string, lang: string): string | null {
	const outFile = join(tmpdir(), `bili_transcript_${randomUUID().slice(0, 8)}.txt`);

	try {
		uvRun(join(SKILL_DIR, "scripts", "fetch_subtitle.py"), [
			url,
			"-c", cookieFile,
			"-l", lang,
			"--no-timestamps",
			"--no-desc",
			"-o", outFile,
		]);

		if (!existsSync(outFile)) return null;
		const text = readFileSync(outFile, "utf-8").trim();

		// Clean up transcript file.
		try { unlinkSync(outFile); } catch { /* ignore */ }

		return text || null;
	} catch {
		return null;
	}
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
 * and returns "success" or "failure".
 */
export async function bilibiliSummaryHandler(run: RunRecord): Promise<"success" | "failure"> {
	const input = run.input as BilibiliRunInput;
	const url = input?.url;
	if (!url) {
		(run as any)._handler_output = { error: "Missing required field: url" };
		return "failure";
	}

	const browser = input.cookie_browser ?? COOKIE_BROWSER;
	const lang = input.lang ?? "ai-zh";

	// Parse BV ID for early validation.
	const bvid = extractBvid(url);
	if (!bvid) {
		(run as any)._handler_output = { error: `Cannot extract BV号 from URL: ${url}` };
		return "failure";
	}

	// Step 1: Extract cookies.
	const cookieFile = extractCookies(browser);
	if (!cookieFile) {
		(run as any)._handler_output = {
			error: `Failed to extract cookies from ${browser} browser.`,
			url,
			bvid,
		};
		return "failure";
	}

	let success = false;
	try {
		const cookies = parseCookies(cookieFile);

		// Step 2: Fetch video metadata.
		const info = await fetchVideoInfo(bvid, cookies);

		// Step 3: Fetch transcript.
		const transcript = fetchTranscript(url, cookieFile, lang);

		// Build output.
		const output: BilibiliRunOutput = {
			bvid,
			url,
			title: info?.title ?? "",
			description: info?.description ?? "",
			duration_text: info?.duration_text ?? "",
			cover_url: info?.cover_url ?? "",
			page_count: info?.page_count ?? 1,
			transcript_length: transcript?.length ?? 0,
			transcript: transcript ?? "",
		};

		if (output.transcript_length === 0 && !output.title) {
			// Nothing useful extracted.
			success = false;
		} else {
			// Store output in the run — the work poller will pass it to complete().
			(run as any)._handler_output = output as unknown as Record<string, unknown>;
			success = transcript !== null || info !== null;
		}
	} finally {
		cleanup(cookieFile);
	}

	return success ? "success" : "failure";
}

/** Extract BV号 from a B站 URL. */
function extractBvid(url: string): string | null {
	const m = url.match(/BV[a-zA-Z0-9]{10}/);
	return m ? m[0] : null;
}

// ─── Re-export for index.ts ──────────────────────────────────────────

export { extractBvid };
