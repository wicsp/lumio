/**
 * Atlas HTTP client — configuration parsing, registration, heartbeat, and redacted diagnostics.
 *
 * Designed as a narrow boundary: only the three endpoints required by RFC 0001.
 * Uses the platform `fetch()` with no extra runtime dependencies.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface AtlasConfig {
	url: string;
	/** Bearer token loaded from ATLAS_AGENT_TOKEN_FILE. */
	token: string;
	nodeId: string;
}

export interface AtlasAgentRegistration {
	agent_id: string;
	name: string;
	capabilities: string[];
	metadata: Record<string, unknown>;
}

export interface AtlasAgentRecord {
	agent_id: string;
	name: string | null;
	capabilities: string[];
	metadata: Record<string, unknown>;
	registered_at: string;
	last_seen_at: string;
	online: boolean;
}

export interface AtlasHealth {
	status: string;
	version: string;
}

export type AtlasClientStatus =
	| { kind: "disconnected"; reason: string }
	| { kind: "connected"; health: AtlasHealth; agent: AtlasAgentRecord | null };

// ─── Configuration ───────────────────────────────────────────────────

/**
 * Parse configuration from environment variables.
 *
 * Token resolution priority:
 *   1. ATLAS_AGENT_TOKEN_FILE — read token from a file (recommended for production;
 *      keeps the secret out of process arguments and environment dumps).
 *   2. ATLAS_AGENT_SHARED_TOKEN — fallback env var (convenient for same-machine
 *      development when the Atlas server env already carries the token).
 *
 * Returns undefined when required variables are missing (integration is disabled).
 */
export function parseConfig(): AtlasConfig | undefined {
	const url = process.env.ATLAS_URL?.trim();
	if (!url) return undefined;

	const nodeId = process.env.ATLAS_NODE_ID?.trim();
	if (!nodeId) return undefined;

	let token: string | undefined;

	// 1. Prefer token file (production path per RFC 0001).
	const tokenFile = process.env.ATLAS_AGENT_TOKEN_FILE?.trim();
	if (tokenFile) {
		try {
			token = readFileSync(tokenFile, "utf-8").trim();
		} catch {
			// File exists but unreadable — don't fall back, surface the error.
		}
	}

	// 2. Fall back to the shared-token env var.
	if (!token) {
		token = process.env.ATLAS_AGENT_SHARED_TOKEN?.trim();
	}

	if (!token) return undefined;

	return { url, token, nodeId };
}

// ─── Identity ────────────────────────────────────────────────────────

/** Generate a session-scoped agent identity. */
export function generateAgentId(config: AtlasConfig): string {
	const sessionId = randomUUID().split("-")[0];
	return `${config.nodeId}.lumio.pi.${sessionId}`;
}

export function generateAgentName(config: AtlasConfig): string {
	return `Lumio pi session on ${config.nodeId}`;
}

// ─── Metadata ────────────────────────────────────────────────────────

/** Build the registration metadata payload per RFC 0001. */
export function buildMetadata(config: AtlasConfig): Record<string, unknown> {
	return {
		node_id: config.nodeId,
		runtime: "pi",
		runtime_version: _piVersion(),
		lumio_version: _lumioVersion(),
		git_revision: _lumioRevision(),
		protocol_version: "atlas-agent-v1",
		interactive: true,
	};
}

function _piVersion(): string {
	try {
		// Resolve the pi package root by walking up from the pi-coding-agent module entry.
		const path = require("node:path");
		const fs = require("node:fs");
		const mod = require.resolve("@earendil-works/pi-coding-agent");
		let dir = path.dirname(mod);
		for (let i = 0; i < 5; i++) {
			const pkgPath = path.join(dir, "package.json");
			if (fs.existsSync(pkgPath)) {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
				return pkg.version ?? "unknown";
			}
			dir = path.dirname(dir);
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

function _lumioVersion(): string {
	try {
		// Walk up from this file to find Lumio's package.json.
		const path = require("node:path");
		const fs = require("node:fs");
		let dir = __dirname;
		for (let i = 0; i < 5; i++) {
			const pkgPath = path.join(dir, "package.json");
			if (fs.existsSync(pkgPath)) {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
				if (pkg.name === "lumio") return pkg.version ?? "unknown";
			}
			dir = path.dirname(dir);
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

function _lumioRevision(): string | null {
	try {
		const { execSync } = require("node:child_process");
		const path = require("node:path");
		const fs = require("node:fs");

		// Find the Lumio repo root.
		let dir = __dirname;
		for (let i = 0; i < 5; i++) {
			if (fs.existsSync(path.join(dir, ".git"))) break;
			dir = path.dirname(dir);
		}

		return execSync("git rev-parse --short HEAD", { cwd: dir, encoding: "utf-8", timeout: 2000 }).trim();
	} catch {
		return null;
	}
}

// ─── HTTP helpers ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

function redactToken(token: string): string {
	if (token.length <= 8) return "***";
	return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeoutMs?: number },
): Promise<Response> {
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});
		return response;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function atlasRequest<T>(
	config: AtlasConfig,
	path: string,
	method: string,
	body?: unknown,
	timeoutMs?: number,
	retries?: number,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	const url = `${config.url.replace(/\/+$/, "")}${path}`;
	const maxRetries = retries ?? MAX_RETRIES;

	let lastError = "";
	let lastStatus = 0;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, {
				method,
				headers: {
					Authorization: `Bearer ${config.token}`,
					"Content-Type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
				timeoutMs,
			});

			if (response.ok) {
				const data = (await response.json()) as T;
				return { ok: true, data };
			}

			// 401/403: don't retry
			if (response.status === 401 || response.status === 403) {
				const text = await response.text().catch(() => "");
				return {
					ok: false,
					status: response.status,
					error: `Atlas rejected authentication (${response.status}): ${text.slice(0, 200)}`,
				};
			}

			lastStatus = response.status;
			lastError = `HTTP ${response.status}`;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("abort")) {
				lastError = "request timed out";
			} else {
				lastError = message;
			}
		}

		// Exponential backoff with jitter
		if (attempt < maxRetries - 1) {
			const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	return { ok: false, status: lastStatus, error: `Atlas unreachable after ${maxRetries} retries: ${lastError}` };
}

// ─── Public API ──────────────────────────────────────────────────────

export interface AtlasClient {
	config: AtlasConfig;
	agentId: string;

	/** Check Atlas health (no auth required). */
	health(): Promise<{ ok: true; data: AtlasHealth } | { ok: false; error: string }>;

	/** Register this session as an agent. */
	register(payload: AtlasAgentRegistration): Promise<
		{ ok: true; data: AtlasAgentRecord } | { ok: false; error: string }
	>;

	/** Send a heartbeat. */
	heartbeat(): Promise<
		{ ok: true; data: AtlasAgentRecord } | { ok: false; error: string }
	>;

	/** Build a human-readable status for the /atlas command. */
	status(): Promise<AtlasClientStatus>;
}

class AtlasHttpClient implements AtlasClient {
	config: AtlasConfig;
	agentId: string;

	private _disconnectedReason: string | null = null;
	private _lastHealth: AtlasHealth | null = null;
	private _lastAgent: AtlasAgentRecord | null = null;

	constructor(config: AtlasConfig, agentId: string) {
		this.config = config;
		this.agentId = agentId;
	}

	async health(): Promise<{ ok: true; data: AtlasHealth } | { ok: false; error: string }> {
		const url = `${this.config.url.replace(/\/+$/, "")}/api/health`;
		try {
			const response = await fetchWithTimeout(url, {}, 3_000);
			if (response.ok) {
				const data = (await response.json()) as AtlasHealth;
				this._lastHealth = data;
				this._disconnectedReason = null;
				return { ok: true, data };
			}
			return { ok: false, error: `HTTP ${response.status}` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
	}

	async register(payload: AtlasAgentRegistration) {
		const result = await atlasRequest<AtlasAgentRecord>(
			this.config,
			"/api/agents/register",
			"POST",
			payload,
		);
		if (result.ok) {
			this._lastAgent = result.data;
			this._disconnectedReason = null;
		} else {
			this._disconnectedReason = result.error;
		}
		return result;
	}

	async heartbeat() {
		const result = await atlasRequest<AtlasAgentRecord>(
			this.config,
			`/api/agents/${encodeURIComponent(this.agentId)}/heartbeat`,
			"POST",
			undefined,
			DEFAULT_TIMEOUT_MS,
			2, // fewer retries for heartbeat
		);
		if (result.ok) {
			this._lastAgent = result.data;
			this._disconnectedReason = null;
		} else {
			this._disconnectedReason = result.error;
		}
		return result;
	}

	async status(): Promise<AtlasClientStatus> {
		const h = await this.health();
		if (!h.ok) {
			return { kind: "disconnected", reason: h.error };
		}
		return {
			kind: "connected",
			health: h.data,
			agent: this._lastAgent,
		};
	}

	/** Build a concise diagnostic string (token redacted). */
	diagnostic(): string {
		const url = this.config.url;
		const token = redactToken(this.config.token);
		const node = this.config.nodeId;
		const agent = this.agentId;
		const disconnected = this._disconnectedReason
			? `\n  last error: ${this._disconnectedReason}`
			: "";
		return `Atlas: ${url} (token=${token}, node=${node}, agent=${agent})${disconnected}`;
	}
}

export function createClient(config: AtlasConfig): AtlasClient {
	const agentId = generateAgentId(config);
	return new AtlasHttpClient(config, agentId);
}
