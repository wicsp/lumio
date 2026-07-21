/**
 * Atlas HTTP client — configuration parsing, registration, heartbeat, and redacted diagnostics.
 *
 * M2.5: supports v2 scoped-credential flow.
 *   - Registration returns a scoped_token.
 *   - Work operations (claim, heartbeat, complete, fail) use the scoped token.
 *   - Registration and agent heartbeat still use the shared (bootstrap) token.
 *
 * Uses the platform `fetch()` with no extra runtime dependencies.
 */

import { readFileSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

export interface AtlasConfig {
  url: string;
  /** Bootstrap token loaded from ATLAS_AGENT_TOKEN_FILE (shared, for registration). */
  token: string;
  nodeId: string;
}

export interface AtlasRunnerRegistration {
  runner_id: string;
  name: string;
  node: {
    node_id: string;
    os?: string;
    arch?: string;
    labels: string[];
  };
  executors: Array<{
    name: string;
    kind: "agent" | "script" | "process";
    version?: string;
  }>;
  available_grants: string[];
  legacy_capabilities: string[];
  metadata: Record<string, unknown>;
}

export interface AtlasRunnerRegistrationResponse {
  runner_id: string;
  scoped_token: string;
  protocol_version: string;
}

export interface AtlasRunnerRecord {
  runner_id: string;
  name: string | null;
  node: AtlasRunnerRegistration["node"];
  executors: AtlasRunnerRegistration["executors"];
  available_grants: string[];
  metadata: Record<string, unknown>;
  registered_at: string;
  last_seen_at: string;
  online: boolean;
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

/**
 * Generate one combined Lumio executor identity from Pi's real session ID.
 * Pi is runtime metadata, not a second agent hierarchy level.
 */
export function generateAgentId(config: AtlasConfig, piSessionId: string): string {
  const instanceId = piSessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "ephemeral";
  return `${config.nodeId}.lumio.${instanceId}`;
}

export function generateAgentName(config: AtlasConfig): string {
  return process.env.LUMIO_AGENT_MODE === "background"
    ? `Lumio background pi on ${config.nodeId}`
    : `Lumio pi session on ${config.nodeId}`;
}

// ─── Metadata ────────────────────────────────────────────────────────

/** Build a runtime-neutral runner registration; job names are legacy-only routing data. */
export function buildRunnerRegistration(
  config: AtlasConfig,
  runnerId: string,
  name: string,
  legacyCapabilities: string[],
  instanceId?: string,
): AtlasRunnerRegistration {
  const background = process.env.LUMIO_AGENT_MODE === "background";
  return {
    runner_id: runnerId,
    name,
    node: {
      node_id: config.nodeId,
      os: process.platform,
      arch: process.arch,
      labels: parseList(process.env.ATLAS_NODE_LABELS),
    },
    executors: [
      { name: "pi", kind: "agent", version: _piVersion() },
      { name: "script", kind: "script", version: _lumioVersion() },
    ],
    available_grants: configuredRunnerGrants(),
    legacy_capabilities: legacyCapabilities,
    metadata: {
      distribution: "lumio",
      distribution_version: _lumioVersion(),
      distribution_revision: _lumioRevision(),
      runner_mode: background ? "background" : "interactive",
      instance_id: instanceId ?? null,
    },
  };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

export function configuredRunnerGrants(): string[] {
  return parseList(process.env.ATLAS_RUNNER_GRANTS);
}

function _piVersion(): string {
  try {
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
  /** If provided, use this token instead of config.token. */
  token?: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = `${config.url.replace(/\/+$/, "")}${path}`;
  const maxRetries = retries ?? MAX_RETRIES;
  const authToken = token ?? config.token;

  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method,
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs,
      });

      if (response.ok) {
        const data = (await response.json()) as T;
        return { ok: true, data };
      }

      // Deterministic client errors will not improve on retry. Preserve the
      // bounded Atlas response so schema failures remain actionable.
      if (response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 429) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          status: response.status,
          error: `Atlas rejected request (${response.status}): ${text.slice(0, 500)}`,
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

  /** The scoped token obtained from registration (v2 work credential). */
  readonly scopedToken: string | null;

  /** Check Atlas health (no auth required). */
  health(): Promise<{ ok: true; data: AtlasHealth } | { ok: false; error: string }>;

  /**
   * Register this session as an agent.
   * Returns the registration response including a scoped token for work operations.
   */
  register(payload: AtlasRunnerRegistration): Promise<
    { ok: true; data: AtlasAgentRecord } | { ok: false; error: string }
  >;

  /** Send a heartbeat using the bootstrap shared token. */
  heartbeat(): Promise<
    { ok: true; data: AtlasAgentRecord } | { ok: false; error: string }
  >;

  /** Build a human-readable status for the /atlas command. */
  status(): Promise<AtlasClientStatus>;

  /** Use the provisioned personal control credential for Source/Resource metadata APIs. */
  controlGet<T>(path: string): Promise<
    { ok: true; data: T } | { ok: false; status: number; error: string }
  >;
  controlPost<T>(path: string, body: unknown): Promise<
    { ok: true; data: T } | { ok: false; status: number; error: string }
  >;
  controlPatch<T>(path: string, body: unknown): Promise<
    { ok: true; data: T } | { ok: false; status: number; error: string }
  >;
}

class AtlasHttpClient implements AtlasClient {
  config: AtlasConfig;
  agentId: string;
  scopedToken: string | null = null;

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

  async register(payload: AtlasRunnerRegistration) {
    const result = await atlasRequest<AtlasRunnerRegistrationResponse>(
      this.config,
      "/api/runners/register",
      "POST",
      payload,
    );
    if (result.ok) {
      const regResp = result.data;
      if (regResp.protocol_version !== "atlas-runner-v1") {
        const error = `Atlas protocol mismatch: expected atlas-runner-v1, received ${regResp.protocol_version || "unknown"}`;
        this._disconnectedReason = error;
        return { ok: false, error };
      }
      this.agentId = regResp.runner_id;
      // Store the scoped token for subsequent work operations.
      if (regResp.scoped_token) {
        this.scopedToken = regResp.scoped_token;
      }
      this._lastAgent = {
        agent_id: regResp.runner_id,
        name: payload.name,
        capabilities: payload.legacy_capabilities,
        metadata: payload.metadata,
        registered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        online: true,
      };
      this._disconnectedReason = null;
      return { ok: true, data: this._lastAgent };
    } else {
      this._disconnectedReason = result.error;
      return { ok: false, error: result.error };
    }
  }

  async heartbeat() {
    const result = await atlasRequest<AtlasRunnerRecord>(
      this.config,
      `/api/runners/${encodeURIComponent(this.agentId)}/heartbeat`,
      "POST",
      undefined,
      DEFAULT_TIMEOUT_MS,
      2, // fewer retries for heartbeat
    );
    if (result.ok) {
      this._lastAgent = {
        agent_id: result.data.runner_id,
        name: result.data.name,
        capabilities: this._lastAgent?.capabilities ?? [],
        metadata: result.data.metadata,
        registered_at: result.data.registered_at,
        last_seen_at: result.data.last_seen_at,
        online: result.data.online,
      };
      this._disconnectedReason = null;
    } else {
      this._disconnectedReason = result.error;
    }
    return result.ok
      ? { ok: true as const, data: this._lastAgent! }
      : result;
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

  async controlGet<T>(path: string) {
    return atlasRequest<T>(this.config, path, "GET", undefined, DEFAULT_TIMEOUT_MS, 1);
  }

  async controlPost<T>(path: string, body: unknown) {
    return atlasRequest<T>(this.config, path, "POST", body, DEFAULT_TIMEOUT_MS, 2);
  }

  async controlPatch<T>(path: string, body: unknown) {
    return atlasRequest<T>(this.config, path, "PATCH", body, DEFAULT_TIMEOUT_MS, 2);
  }

  /** Build a concise diagnostic string (token redacted). */
  diagnostic(): string {
    const url = this.config.url;
    const token = redactToken(this.config.token);
    const node = this.config.nodeId;
    const agent = this.agentId;
    const scoped = this.scopedToken ? `scoped=${redactToken(this.scopedToken)}` : "no scoped token";
    const disconnected = this._disconnectedReason
      ? `\n  last error: ${this._disconnectedReason}`
      : "";
    return `Atlas: ${url} (bootstrap_token=${token}, ${scoped}, node=${node}, agent=${agent})${disconnected}`;
  }
}

export function createClient(config: AtlasConfig, piSessionId: string): AtlasClient {
  const agentId = generateAgentId(config, piSessionId);
  return new AtlasHttpClient(config, agentId);
}
