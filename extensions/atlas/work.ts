/**
 * Atlas Work Polling — M2.5 Execution Hardening (Lumio side).
 *
 * Polls Atlas for pending work, claims runs with lease enforcement,
 * heartbeats active claims, and reports results with artifact references.
 * Integration is optional; failure never blocks local pi usage.
 *
 * M2.5 changes:
 *   - Typed HandlerResult replaces raw "success"/"failure" strings.
 *   - Unknown jobs explicitly fail; no silent success.
 *   - Result reporting is idempotent-retried; ambiguous failures are retried.
 *   - Lease-loss is detected and surfaced as a distinct diagnostic.
 *   - Report results are checked; false success cannot be assumed.
 */

import type { AtlasClient } from "./client";

// ─── Auth helper ──────────────────────────────────────────────

/** Return the work-scoped auth token: scoped (v2) preferred over shared (v1). */
function workToken(client: AtlasClient): string {
  return client.scopedToken ?? client.config.token;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkConfig {
  /** Agent capabilities to advertise when polling. */
  capabilities: string[];
  /** Poll interval in milliseconds (default: 10s). */
  pollIntervalMs: number;
  /** Heartbeat interval in milliseconds (default: 15s, must be less than Atlas lease TTL). */
  heartbeatIntervalMs: number;
}

export interface ArtifactRefCreate {
  name: string;
  uri: string;
  content_type?: string;
  size_bytes?: number;
  checksum?: string;
}

export interface ArtifactRef {
  artifact_id: string;
  run_id: string;
  name: string;
  uri: string;
  content_type: string | null;
  size_bytes: number | null;
  checksum: string | null;
  created_at: string;
}

/** Typed handler result per RFC 0002. */
export type HandlerResult =
  | {
      status: "success";
      output: Record<string, unknown>;
      artifacts: ArtifactRefCreate[];
    }
  | {
      status: "failure";
      code: string;
      message: string;
      retryable: boolean;
    };

export interface RunRecord {
  run_id: string;
  project_id: string;
  job_name: string;
  capabilities_required: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: "pending" | "claimed" | "completed" | "failed" | "cancelled";
  agent_id: string | null;
  lease_expires_at: string | null;
  attempt_number: number;
  max_attempts: number;
  priority: number;
  metadata: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type WorkStatus =
  | { kind: "idle" }
  | {
      kind: "claimed";
      run: RunRecord;
      claimedAt: number;
      lastHeartbeatAt: number;
    }
  | {
      kind: "completed";
      run: RunRecord;
      completedAt: number;
      result: "success" | "failure";
      detail: string;
    };

// ─── HTTP helpers ────────────────────────────────────────────────────

const IDEMPOTENCY_RETRY_DELAY_MS = 2_000;
const IDEMPOTENCY_MAX_RETRIES = 3;

async function atlasWorkGet<T>(
  client: AtlasClient,
  path: string,
  timeoutMs = 5_000,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = `${client.config.url.replace(/\/+$/, "")}${path}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${workToken(client)}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      return { ok: true, data: (await response.json()) as T };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function atlasWorkPost<T>(
  client: AtlasClient,
  path: string,
  body?: unknown,
  timeoutMs = 5_000,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = `${client.config.url.replace(/\/+$/, "")}${path}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workToken(client)}`,
        "Content-Type": "application/json",
        ...(extraHeaders ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      return { ok: true, data: (await response.json()) as T };
    }
    // Capture response body for error details
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errBody = await response.text();
      if (errBody) errorDetail += `: ${errBody.slice(0, 200)}`;
    } catch { /* ignore */ }
    return { ok: false, status: response.status, error: errorDetail };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Retry an idempotent POST request.
 * 409 means a conflicting state (not retryable).
 * 0 or network error means ambiguous — retry.
 * Success returns the data.
 */
/** Generate a v4-like random UUID for idempotency keys. */
function randomIdempotencyKey(): string {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `idem-${hex}`;
}

/**
 * Retry an idempotent POST request.
 * Each call generates a fresh Idempotency-Key.
 * 409 means a conflicting state (not retryable).
 * 0 or network error means ambiguous — retry with the SAME key.
 * Success returns the data.
 */
async function idempotentPost<T>(
  client: AtlasClient,
  path: string,
  body: unknown,
  timeoutMs = 5_000,
): Promise<
  | { ok: true; data: T }
  | { ok: false; reason: "conflict" | "network" | "other"; error: string }
> {
  const idemKey = randomIdempotencyKey();
  const headers = { "Idempotency-Key": idemKey };
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_RETRIES; attempt++) {
    const result = await atlasWorkPost<T>(
      client, path, body, timeoutMs, headers,
    );

    if (result.ok) return { ok: true, data: result.data };

    // 409 Conflict — terminal, don't retry.
    if (result.status === 409) {
      return { ok: false, reason: "conflict", error: result.error };
    }

    // 0 or network error — ambiguous, retry.
    if (result.status === 0 || result.status >= 500) {
      if (attempt < IDEMPOTENCY_MAX_RETRIES - 1) {
        const delay = IDEMPOTENCY_RETRY_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }

    // Other errors (4xx non-409) — don't retry.
    return { ok: false, reason: "other", error: result.error };
  }

  return { ok: false, reason: "network", error: "Exhausted retries" };
}

// ─── Work Poller ─────────────────────────────────────────────────────

export interface WorkPoller {
  readonly config: WorkConfig;
  readonly status: () => WorkStatus;
  stop: () => void;
}

export function startWorkPoller(
  client: AtlasClient,
  cfg: Partial<WorkConfig>,
  onWork: (run: RunRecord, signal: AbortSignal) => Promise<HandlerResult>,
  onStatusChange?: (status: WorkStatus) => void,
): WorkPoller {
  const config: WorkConfig = {
    capabilities: cfg.capabilities ?? [],
    pollIntervalMs: cfg.pollIntervalMs ?? 10_000,
    heartbeatIntervalMs: cfg.heartbeatIntervalMs ?? 15_000,
  };

  let currentRun: RunRecord | null = null;
  let claimedAt = 0;
  let lastHeartbeatAt = 0;
  let completedAt = 0;
  let lastResult: "success" | "failure" = "success";
  let lastDetail = "";

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hbTimer: ReturnType<typeof setInterval> | null = null;
  let currentController: AbortController | null = null;
  let stopped = false;

  function getStatus(): WorkStatus {
    if (completedAt > 0 && currentRun) {
      return { kind: "completed", run: currentRun, completedAt, result: lastResult, detail: lastDetail };
    }
    if (currentRun) {
      return { kind: "claimed", run: currentRun, claimedAt, lastHeartbeatAt };
    }
    return { kind: "idle" };
  }

  function notifyStatus() {
    onStatusChange?.(getStatus());
  }

  async function claimNext(): Promise<RunRecord | null> {
    const result = await atlasWorkGet<RunRecord | null>(client, "/api/runs/next");
    if (!result.ok) return null;
    return result.data;
  }

  async function sendHeartbeat(runId: string): Promise<boolean> {
    const path = `/api/runs/${encodeURIComponent(runId)}/heartbeat`;
    const result = await atlasWorkPost<RunRecord>(client, path);
    return result.ok;
  }

  /**
   * Report completion to Atlas with idempotent retry.
   * Returns true if Atlas accepted the result, false otherwise.
   */
  async function reportComplete(
    runId: string,
    output: Record<string, unknown>,
    artifacts: ArtifactRefCreate[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const payload = {
      agent_id: client.agentId,
      output,
      artifacts,
    };
    const path = `/api/runs/${encodeURIComponent(runId)}/complete`;
    const result = await idempotentPost<RunRecord>(client, path, payload);

    if (result.ok) return { ok: true };

    switch (result.reason) {
      case "conflict":
        return { ok: false, reason: `Atlas rejected completion: ${result.error}` };
      case "network":
        return { ok: false, reason: `Cannot reach Atlas after retries: ${result.error}` };
      default:
        return { ok: false, reason: result.error };
    }
  }

  /**
   * Report failure to Atlas with idempotent retry.
   */
  async function reportFailure(
    runId: string,
    code: string,
    message: string,
    retryable = false,
  ): Promise<{ ok: boolean; reason?: string }> {
    const payload = {
      agent_id: client.agentId,
      error_code: code,
      error_message: message,
      retryable,
    };
    const path = `/api/runs/${encodeURIComponent(runId)}/fail`;
    const result = await idempotentPost<RunRecord>(client, path, payload);

    if (result.ok) return { ok: true };

    switch (result.reason) {
      case "conflict":
        return { ok: false, reason: `Atlas rejected failure report: ${result.error}` };
      case "network":
        return { ok: false, reason: `Cannot reach Atlas after retries: ${result.error}` };
      default:
        return { ok: false, reason: result.error };
    }
  }

  function startClaimHeartbeat(run: RunRecord, controller: AbortController) {
    stopClaimHeartbeat();
    currentRun = run;
    claimedAt = Date.now();
    lastHeartbeatAt = Date.now();
    completedAt = 0;
    currentController = controller;
    hbTimer = setInterval(async () => {
      if (stopped || !currentRun) {
        stopClaimHeartbeat();
        return;
      }
      const ok = await sendHeartbeat(run.run_id);
      if (!ok) {
        // Lease lost — abort the handler and go back to idle.
        controller.abort();
        if (currentController === controller) {
          currentRun = null;
          stopClaimHeartbeat();
          notifyStatus();
        }
        return;
      }
      lastHeartbeatAt = Date.now();
    }, config.heartbeatIntervalMs);

    if ("unref" in hbTimer) (hbTimer as NodeJS.Timeout).unref();
    notifyStatus();
  }

  function stopClaimHeartbeat() {
    if (hbTimer !== null) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
    currentController = null;
  }

  async function executeRun(run: RunRecord) {
    const controller = new AbortController();
    startClaimHeartbeat(run, controller);

    try {
      const handlerResult = await onWork(run, controller.signal);

      if (controller.signal.aborted) {
        lastResult = "failure";
        lastDetail = "execution cancelled after lease loss or shutdown";
        return;
      }

      if (handlerResult.status === "success") {
        const reportResult = await reportComplete(
          run.run_id,
          handlerResult.output,
          handlerResult.artifacts,
        );

        if (reportResult.ok) {
          lastResult = "success";
          lastDetail = "completed";
        } else {
          // Atlas didn't accept the completion.
          // Don't silently claim success — mark as failure.
          lastResult = "failure";
          lastDetail = `completion rejected: ${reportResult.reason}`;
        }
      } else {
        // Handler returned failure.
        const reportResult = await reportFailure(
          run.run_id,
          handlerResult.code,
          handlerResult.message,
          handlerResult.retryable,
        );

        lastResult = "failure";
        if (reportResult.ok) {
          lastDetail = `reported: [${handlerResult.code}] ${handlerResult.message}`;
        } else {
          lastDetail = `report failed: ${reportResult.reason}`;
        }
      }
    } catch (err) {
      lastResult = "failure";
      const msg = err instanceof Error ? err.message : String(err);
      lastDetail = `handler crashed: ${msg.slice(0, 500)}`;

      if (!controller.signal.aborted) {
        // Best-effort failure report.
        await reportFailure(run.run_id, "handler_crash", msg);
      }
    } finally {
      if (currentController === controller) {
        completedAt = Date.now();
        stopClaimHeartbeat();
        notifyStatus();
      }
    }
  }

  async function poll() {
    if (stopped) return;

    // Don't poll if currently executing a run
    if (currentRun && completedAt === 0) return;

    // After completing, return to idle after one cycle
    if (completedAt > 0) {
      currentRun = null;
      completedAt = 0;
      notifyStatus();
    }

    const run = await claimNext();
    if (run) {
      // Don't await — let execution happen in background
      executeRun(run);
    }
  }

  // Start polling
  pollTimer = setInterval(poll, config.pollIntervalMs);
  if ("unref" in pollTimer) (pollTimer as NodeJS.Timeout).unref();

  // Do an initial poll immediately
  poll();

  return {
    config,
    status: getStatus,
    stop: () => {
      stopped = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (currentController !== null) {
        currentController.abort();
      }
      stopClaimHeartbeat();
      currentRun = null;
    },
  };
}
