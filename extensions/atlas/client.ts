/**
 * Atlas HTTP client — configuration parsing, health checks, and control API access.
 *
 * Provides a lightweight client for Lumio's user-facing Atlas commands.
 * Does NOT register as a Runner or maintain a heartbeat; background
 * execution is handled by AtlasRunner.
 */

import { readFileSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

export interface AtlasConfig {
  url: string;
  token: string;
  nodeId: string;
}

export interface AtlasHealth {
  status: string;
  version: string;
}

export type AtlasClientStatus =
  | { kind: "disconnected"; reason: string }
  | { kind: "connected"; health: AtlasHealth };

// ─── Configuration ───────────────────────────────────────────────────

/**
 * Parse configuration from environment variables.
 *
 * Token resolution priority:
 *   1. ATLAS_AGENT_TOKEN_FILE — read token from a file (recommended for production).
 *   2. ATLAS_AGENT_SHARED_TOKEN — fallback env var.
 *
 * Returns undefined when required variables are missing (integration is disabled).
 */
export function parseConfig(): AtlasConfig | undefined {
  const url = process.env.ATLAS_URL?.trim();
  if (!url) return undefined;

  const nodeId = process.env.ATLAS_NODE_ID?.trim();
  if (!nodeId) return undefined;

  let token: string | undefined;

  // 1. Prefer token file.
  const tokenFile = process.env.ATLAS_AGENT_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf-8").trim();
    } catch {
      // File exists but unreadable — don't fall back.
    }
  }

  // 2. Fall back to the shared-token env var.
  if (!token) {
    token = process.env.ATLAS_AGENT_SHARED_TOKEN?.trim();
  }

  if (!token) return undefined;

  return { url, token, nodeId };
}

// ─── HTTP helpers ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

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

      // Deterministic client errors will not improve on retry.
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

  /** Check Atlas health (no auth required). */
  health(): Promise<{ ok: true; data: AtlasHealth } | { ok: false; error: string }>;

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

  private _disconnectedReason: string | null = null;
  private _lastHealth: AtlasHealth | null = null;

  constructor(config: AtlasConfig) {
    this.config = config;
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

  async status(): Promise<AtlasClientStatus> {
    const h = await this.health();
    if (!h.ok) {
      return { kind: "disconnected", reason: h.error };
    }
    return {
      kind: "connected",
      health: h.data,
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
}

export function createClient(config: AtlasConfig): AtlasClient {
  return new AtlasHttpClient(config);
}
