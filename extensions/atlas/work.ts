/**
 * Atlas Work Polling — RFC 0002 bounded in-memory reliability (Lumio side).
 *
 * Every claim creates an AttemptContext that owns all per-attempt state
 * (runId, credentials, controller, timers, in-flight promises).  All async
 * callbacks check that their context is still current before mutating
 * global state, so an old heartbeat or deadline timer can never abort a
 * successor attempt.
 *
 * Credentials are stripped from the public RunRecord before the handler
 * or status callbacks ever see them.
 *
 * Key invariants (round 2 hardening):
 * - One deadline timer per context, atomically replaced on heartbeat.
 * - One in-flight heartbeat at a time (single-flight via heartbeatPromise).
 * - HTTP requests cancelled on lease loss via context AbortSignal.
 * - Terminal report timeout never exceeds remaining lease.
 * - Only 401/403/409 trigger lease loss; other 4xx are report-rejected.
 * - Expired / backwards-deadline claims and heartbeats are rejected.
 * - stop() during a claim request does not start the handler.
 */

import type { AtlasClient } from "./client";

// ─── Auth helper ──────────────────────────────────────────────

function workToken(client: AtlasClient): string {
  return client.scopedToken ?? client.config.token;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkConfig {
  capabilities: string[];
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  leaseSafetyMarginMs: number;
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

export type HandlerResult =
  | { status: "success"; output: Record<string, unknown>; artifacts: ArtifactRefCreate[] }
  | { status: "failure"; code: string; message: string; retryable: boolean };

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
  /** Present on the raw claim response; stripped from public RunRecord. */
  attempt_id?: string;
  claim_token?: string;
}

export type WorkStatus =
  | { kind: "idle" }
  | {
      kind: "claimed";
      run: RunRecord;
      claimedAt: number;
      lastHeartbeatAt: number;
      leaseExpiresAt: number;
    }
  | {
      kind: "completed";
      run: RunRecord;
      completedAt: number;
      result: "success" | "failure";
      detail: string;
    }
  | {
      kind: "abandoned";
      run: RunRecord;
      reason: string;
    };

// ─── Attempt context ─────────────────────────────────────────────────

interface AttemptContext {
  /** Monotonic id — used to detect stale callbacks. */
  readonly id: number;
  readonly runId: string;
  /** Public run record (credentials stripped). */
  readonly publicRun: RunRecord;
  readonly attemptId: string;
  readonly claimToken: string;
  /** Server lease deadline as epoch ms. Updated by heartbeat. */
  deadlineMs: number;
  controller: AbortController;
  leaseLost: boolean;
  lossReason: string;
  handlerDone: boolean;
  reportInFlight: boolean;
  /** Timers that must be cleared on teardown. */
  timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
  /** Set of in-flight promise rejectors for cancelable sleep. */
  sleepRejectors: Set<(err: Error) => void>;
  /** Current deadline timer (at most one at a time). */
  deadlineTimerId: ReturnType<typeof setTimeout> | null;
  /** Single-flight heartbeat — non-null while a heartbeat is in progress. */
  heartbeatPromise: Promise<boolean> | null;
}

let _nextContextId = 1;

function createContext(run: RunRecord): AttemptContext {
  return {
    id: _nextContextId++,
    runId: run.run_id,
    publicRun: stripCredentials(run),
    attemptId: run.attempt_id!,
    claimToken: run.claim_token!,
    deadlineMs: new Date(run.lease_expires_at!).getTime(),
    controller: new AbortController(),
    leaseLost: false,
    lossReason: "",
    handlerDone: false,
    reportInFlight: false,
    timers: [],
    sleepRejectors: new Set(),
    deadlineTimerId: null,
    heartbeatPromise: null,
  };
}

/** Return a copy of the run record with credentials removed. */
function stripCredentials(run: RunRecord): RunRecord {
  const { attempt_id: _aid, claim_token: _ct, ...rest } = run;
  return rest as RunRecord;
}

// ─── Sleep helpers ───────────────────────────────────────────────────

/** Sleep that rejects if the context is no longer current or is stopped. */
function sleepCheck(ms: number, ctx: AttemptContext, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ctx.sleepRejectors) ctx.sleepRejectors.delete(rejector);
      resolve();
    }, ms);
    const rejector = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    ctx.sleepRejectors.add(rejector);

    // Quick poll: if already stale or lease lost, reject immediately.
    if (!isCurrent() || ctx.leaseLost) {
      clearTimeout(timer);
      ctx.sleepRejectors.delete(rejector);
      reject(new Error("context stale"));
    }
  });
}

function cancelAllSleeps(ctx: AttemptContext, reason: string) {
  const err = new Error(reason);
  for (const rejector of ctx.sleepRejectors) {
    rejector(err);
  }
  ctx.sleepRejectors.clear();
}

// ─── HTTP helpers ────────────────────────────────────────────────────

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
      headers: { Authorization: `Bearer ${workToken(client)}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) return { ok: true, data: (await response.json()) as T };
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
  externalSignal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = `${client.config.url.replace(/\/+$/, "")}${path}`;
  if (externalSignal?.aborted) {
    return { ok: false, status: 0, error: "cancelled" };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
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
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errBody = await response.text();
      if (errBody) errorDetail += `: ${errBody.slice(0, 200)}`;
    } catch { /* ignore */ }
    return { ok: false, status: response.status, error: errorDetail };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** True when the HTTP status is a definitive server rejection (not transient). */
function isTransient(status: number): boolean {
  // 0 = network/timeout error — ambiguous, retryable.
  if (status === 0) return true;
  // 5xx — server-side transient, retryable.
  if (status >= 500) return true;
  // All 4xx — server explicitly rejected; not transient.
  return false;
}

/** True when the status permanently invalidates the current attempt. */
function isAttemptGone(status: number): boolean {
  return status === 401 || status === 403 || status === 409;
}

function randomIdempotencyKey(): string {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `idem-${hex}`;
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
    leaseSafetyMarginMs: cfg.leaseSafetyMarginMs ?? 5_000,
  };

  // ── Global state ────────────────────────────────────────────
  let currentContext: AttemptContext | null = null;
  let claimedAt = 0;
  let lastHeartbeatAt = 0;

  /** Completed or abandoned context for one-cycle display. */
  let settledContext: {
    ctx: AttemptContext;
    completedAt: number;
    result: "success" | "failure";
    detail: string;
  } | null = null;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let stopped = false;

  function nowMs() {
    return Date.now();
  }

  /** Check whether a context is still the active one. */
  function isCurrent(ctx: AttemptContext): boolean {
    return currentContext?.id === ctx.id;
  }

  // ── Status helpers ──────────────────────────────────────────
  function getStatus(): WorkStatus {
    if (currentContext && !currentContext.leaseLost) {
      return {
        kind: "claimed",
        run: currentContext.publicRun,
        claimedAt,
        lastHeartbeatAt,
        leaseExpiresAt: currentContext.deadlineMs,
      };
    }
    if (currentContext?.leaseLost) {
      return {
        kind: "abandoned",
        run: currentContext.publicRun,
        reason: currentContext.lossReason,
      };
    }
    if (settledContext) {
      const sc = settledContext;
      return sc.ctx.leaseLost
        ? { kind: "abandoned", run: sc.ctx.publicRun, reason: sc.ctx.lossReason }
        : { kind: "completed", run: sc.ctx.publicRun, completedAt: sc.completedAt, result: sc.result, detail: sc.detail };
    }
    return { kind: "idle" };
  }

  function notifyStatus() {
    onStatusChange?.(getStatus());
  }

  // ── Context-bound deadline timer ────────────────────────────
  /**
   * Set (or replace) the single deadline timer for this context.
   * Each call cancels the previous timer so there is always at most one.
   */
  function scheduleDeadlineTimer(ctx: AttemptContext) {
    if (!isCurrent(ctx) || ctx.leaseLost || stopped) return;
    // Cancel previous timer if any.
    if (ctx.deadlineTimerId !== null) {
      clearTimeout(ctx.deadlineTimerId);
    }

    const remainingMs = ctx.deadlineMs - config.leaseSafetyMarginMs - nowMs();
    if (remainingMs <= 0) {
      if (isCurrent(ctx)) signalLeaseLost(ctx, "lease deadline reached");
      ctx.deadlineTimerId = null;
      return;
    }

    const timer = setTimeout(() => {
      if (isCurrent(ctx)) signalLeaseLost(ctx, "lease deadline timer fired");
      ctx.deadlineTimerId = null;
    }, remainingMs);
    if ("unref" in timer) timer.unref();
    ctx.deadlineTimerId = timer;
  }

  // ── Context-bound lease-loss ────────────────────────────────
  function signalLeaseLost(ctx: AttemptContext, reason: string) {
    if (ctx.leaseLost) return;
    ctx.leaseLost = true;
    ctx.lossReason = reason;
    // Cancel deadline timer to prevent double-fire.
    if (ctx.deadlineTimerId !== null) {
      clearTimeout(ctx.deadlineTimerId);
      ctx.deadlineTimerId = null;
    }
    cancelAllSleeps(ctx, reason);
    ctx.controller.abort();
    notifyStatus();
  }

  // ── Heartbeat ───────────────────────────────────────────────
  async function sendHeartbeat(
    ctx: AttemptContext,
    timeoutMs: number,
  ): Promise<
    | { ok: true; deadlineMs: number }
    | { ok: false; definitive: boolean; status: number; error: string }
  > {
    const path = `/api/runs/${encodeURIComponent(ctx.runId)}/heartbeat`;
    const body = { attempt_id: ctx.attemptId, claim_token: ctx.claimToken };
    const result = await atlasWorkPost<{ lease_expires_at?: string } & RunRecord>(
      client, path, body, timeoutMs, undefined, ctx.controller.signal,
    );

    if (result.ok) {
      const expiresAt = result.data.lease_expires_at;
      if (!expiresAt) {
        return { ok: false, definitive: false, status: 0, error: "missing lease_expires_at" };
      }
      const newDeadlineMs = new Date(expiresAt).getTime();
      if (isNaN(newDeadlineMs)) {
        return { ok: false, definitive: true, status: 0, error: "invalid lease_expires_at in heartbeat response" };
      }
      // Reject backwards deadline (server tried to shrink the lease).
      if (newDeadlineMs <= ctx.deadlineMs) {
        return { ok: false, definitive: false, status: 0, error: "backwards lease deadline in heartbeat response" };
      }
      return { ok: true, deadlineMs: newDeadlineMs };
    }

    // Non-transient → definitive (don't retry).
    if (!isTransient(result.status)) {
      return { ok: false, definitive: true, status: result.status, error: result.error };
    }
    return { ok: false, definitive: false, status: result.status, error: result.error };
  }

  async function heartbeatWithRetry(ctx: AttemptContext): Promise<boolean> {
    for (let retry = 0; retry < 10; retry++) {
      if (stopped || !isCurrent(ctx) || ctx.leaseLost) return false;

      const remainingMs = ctx.deadlineMs - config.leaseSafetyMarginMs - nowMs();
      if (remainingMs <= 0) {
        if (isCurrent(ctx)) signalLeaseLost(ctx, "lease deadline reached");
        return false;
      }

      const timeoutMs = Math.min(5_000, remainingMs);
      const res = await sendHeartbeat(ctx, timeoutMs);

      // Re-check after HTTP await — context may have been torn down.
      if (stopped || !isCurrent(ctx) || ctx.leaseLost) return false;

      if (res.ok) {
        ctx.deadlineMs = res.deadlineMs;
        lastHeartbeatAt = nowMs();
        // Atomically replace the deadline timer.
        scheduleDeadlineTimer(ctx);
        notifyStatus();
        return true;
      }

      if (res.definitive) {
        // If the handler already finished, the terminal report decides the
        // outcome — a late heartbeat 401/403/409 must not override that.
        if (isCurrent(ctx) && !ctx.handlerDone) {
          signalLeaseLost(ctx, `heartbeat rejected (${res.status}): ${res.error}`);
        }
        return false;
      }

      // Ambiguous — backoff and retry, but clip to remaining deadline.
      const delay = Math.min(
        1_000 * Math.pow(2, retry) * (0.5 + Math.random() * 0.5),
        remainingMs,
      );
      try {
        await sleepCheck(delay, ctx, () => isCurrent(ctx));
      } catch {
        return false; // context stale or lease loss interrupted the sleep
      }
    }

    if (isCurrent(ctx) && nowMs() >= ctx.deadlineMs - config.leaseSafetyMarginMs) {
      signalLeaseLost(ctx, "lease deadline reached after heartbeat failures");
    }
    return false;
  }

  /**
   * Single-flight heartbeat: returns the in-flight promise if a heartbeat
   * is already running, otherwise starts a new one.  On success, the
   * deadline timer is atomically replaced.  On completion (success or
   * failure), the promise slot is cleared.
   */
  function heartbeatSingleFlight(ctx: AttemptContext): Promise<boolean> {
    if (ctx.heartbeatPromise !== null) return ctx.heartbeatPromise;

    const promise = heartbeatWithRetry(ctx).finally(() => {
      ctx.heartbeatPromise = null;
    });
    ctx.heartbeatPromise = promise;
    return promise;
  }

  // ── Terminal report ─────────────────────────────────────────
  async function reportTerminal(
    ctx: AttemptContext,
    payload: Record<string, unknown>,
    path: string,
    intent: "complete" | "fail",
  ): Promise<{ accepted: boolean; reason: string }> {
    if (ctx.reportInFlight) return { accepted: false, reason: "report already in flight" };
    ctx.reportInFlight = true;

    const idemKey = randomIdempotencyKey();
    const headers = { "Idempotency-Key": idemKey };

    try {
      for (let retry = 0; retry < 20; retry++) {
        if (stopped || !isCurrent(ctx) || ctx.leaseLost) {
          return { accepted: false, reason: ctx.lossReason || "stopped" };
        }

        const remainingMs = ctx.deadlineMs - config.leaseSafetyMarginMs - nowMs();
        if (remainingMs <= 0) {
          if (isCurrent(ctx)) signalLeaseLost(ctx, "lease deadline reached during terminal report");
          return { accepted: false, reason: "lease expired before report accepted" };
        }

        const timeoutMs = Math.min(5_000, remainingMs);
        const result = await atlasWorkPost<RunRecord>(
          client, path, payload, timeoutMs, headers, ctx.controller.signal,
        );

        // Re-check after HTTP await — context may have been torn down.
        if (stopped || !isCurrent(ctx) || ctx.leaseLost) {
          return { accepted: false, reason: ctx.lossReason || "stopped" };
        }

        if (result.ok) {
          return { accepted: true, reason: "accepted" };
        }

        if (!isTransient(result.status)) {
          // Only 401/403/409 invalidate the attempt.  Other 4xx (400, 422)
          // mean the report was rejected but the attempt is still valid.
          if (isAttemptGone(result.status)) {
            if (isCurrent(ctx)) {
              signalLeaseLost(ctx, `${intent} report rejected (${result.status}): ${result.error}`);
            }
            return { accepted: false, reason: `Atlas rejected (attempt lost): ${result.error}` };
          }
          // Other definitive errors (400, 422, etc.) — report rejected, don't retry.
          return { accepted: false, reason: `Atlas rejected: ${result.error}` };
        }

        // Ambiguous — fire heartbeat to extend lease, then backoff.
        heartbeatSingleFlight(ctx).catch(() => {});

        const delay = Math.min(
          2_000 * Math.pow(2, Math.min(retry, 4)) * (0.5 + Math.random() * 0.5),
          Math.max(100, remainingMs),
        );
        try {
          await sleepCheck(delay, ctx, () => isCurrent(ctx));
        } catch {
          return { accepted: false, reason: ctx.lossReason || "context stale" };
        }
      }
      return { accepted: false, reason: "exhausted terminal-report retries" };
    } finally {
      ctx.reportInFlight = false;
    }
  }

  async function reportComplete(
    ctx: AttemptContext,
    output: Record<string, unknown>,
    artifacts: ArtifactRefCreate[],
  ): Promise<{ accepted: boolean; reason: string }> {
    return reportTerminal(ctx, {
      attempt_id: ctx.attemptId,
      claim_token: ctx.claimToken,
      agent_id: client.agentId,
      output,
      artifacts,
    }, `/api/runs/${encodeURIComponent(ctx.runId)}/complete`, "complete");
  }

  async function reportFailure(
    ctx: AttemptContext,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<{ accepted: boolean; reason: string }> {
    return reportTerminal(ctx, {
      attempt_id: ctx.attemptId,
      claim_token: ctx.claimToken,
      agent_id: client.agentId,
      error_code: code,
      error_message: message,
      retryable,
    }, `/api/runs/${encodeURIComponent(ctx.runId)}/fail`, "fail");
  }

  // ── Claim ───────────────────────────────────────────────────
  async function claimNext(): Promise<RunRecord | null> {
    const result = await atlasWorkGet<RunRecord | null>(client, "/api/runs/next");
    if (!result.ok) return null;
    return result.data;
  }

  // ── Execute ─────────────────────────────────────────────────
  async function executeRun(run: RunRecord) {
    if (!run.attempt_id || !run.claim_token || !run.lease_expires_at) {
      settledContext = {
        ctx: createContext(run),
        completedAt: nowMs(),
        result: "failure",
        detail: "protocol error: claim response missing attempt_id / claim_token / lease_expires_at",
      };
      notifyStatus();
      return;
    }

    const deadlineMs = new Date(run.lease_expires_at).getTime();
    if (isNaN(deadlineMs)) {
      settledContext = {
        ctx: createContext(run),
        completedAt: nowMs(),
        result: "failure",
        detail: "protocol error: invalid lease_expires_at in claim response",
      };
      notifyStatus();
      return;
    }

    // Reject expired claim lease.
    if (deadlineMs <= nowMs() + config.leaseSafetyMarginMs) {
      settledContext = {
        ctx: createContext(run),
        completedAt: nowMs(),
        result: "failure",
        detail: "claimed run with already-expired lease — skipping",
      };
      notifyStatus();
      return;
    }

    const ctx = createContext(run);
    currentContext = ctx;
    claimedAt = nowMs();
    lastHeartbeatAt = nowMs();
    notifyStatus();

    // ── Deadline timer (context-bound, atomically replaceable) ─
    scheduleDeadlineTimer(ctx);

    // ── Heartbeat loop (context-bound, single-flight) ────────
    const hbTimer = setInterval(async () => {
      if (!isCurrent(ctx)) {
        clearInterval(hbTimer);
        return;
      }
      if (ctx.leaseLost || stopped) return;
      const ok = await heartbeatSingleFlight(ctx);
      // deadline timer already replaced inside heartbeatSingleFlight on success.
      void ok; // unused
    }, config.heartbeatIntervalMs);
    if ("unref" in hbTimer) hbTimer.unref();
    ctx.timers.push(hbTimer);

    // Kick off first heartbeat immediately.
    heartbeatSingleFlight(ctx).catch(() => {});

    let result: "success" | "failure" = "failure";
    let detail = "";

    try {
      // ── Run handler (with credential-stripped public run) ─
      const handlerResult = await onWork(ctx.publicRun, ctx.controller.signal);
      ctx.handlerDone = true;

      if (ctx.controller.signal.aborted || ctx.leaseLost) {
        result = "failure";
        detail = `execution aborted: ${ctx.lossReason || "shutdown or lease loss"}`;
        return;
      }

      // ── Terminal report ─────────────────────────────────
      if (handlerResult.status === "success") {
        const rep = await reportComplete(ctx, handlerResult.output, handlerResult.artifacts);
        if (rep.accepted) { result = "success"; detail = "completed"; }
        else { result = "failure"; detail = `completion rejected: ${rep.reason}`; }
      } else {
        const rep = await reportFailure(ctx, handlerResult.code, handlerResult.message, handlerResult.retryable);
        result = "failure";
        detail = rep.accepted
          ? `reported: [${handlerResult.code}] ${handlerResult.message}`
          : `report failed: ${rep.reason}`;
      }
    } catch (err) {
      // Mark handler as done so background heartbeat 401/403/409
      // won't override the terminal report outcome.
      ctx.handlerDone = true;

      result = "failure";
      const msg = err instanceof Error ? err.message : String(err);
      detail = `handler crashed: ${msg.slice(0, 500)}`;

      // Bounded crash report: wait for it (terminates at deadline).
      if (!ctx.controller.signal.aborted && !ctx.leaseLost && isCurrent(ctx)) {
        try {
          await reportFailure(ctx, "handler_crash", msg, false);
        } catch {
          // ignore secondary failures
        }
      }
    } finally {
      // ── Teardown ─────────────────────────────────────────
      // Cancel any in-flight heartbeat / terminal-report HTTP requests.
      ctx.controller.abort();

      if (ctx.deadlineTimerId !== null) {
        clearTimeout(ctx.deadlineTimerId);
        ctx.deadlineTimerId = null;
      }
      for (const timer of ctx.timers) {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        clearInterval(timer as ReturnType<typeof setInterval>);
      }
      cancelAllSleeps(ctx, "teardown");

      if (isCurrent(ctx)) {
        currentContext = null;
        settledContext = { ctx, completedAt: nowMs(), result, detail };
      }
      notifyStatus();
    }
  }

  // ── Poll loop ───────────────────────────────────────────────
  async function poll() {
    if (stopped || pollInFlight) return;
    pollInFlight = true;

    try {
      if (currentContext) return; // execution in progress

      if (settledContext) {
        settledContext = null;
        notifyStatus();
      }

      if (stopped) return;

      const run = await claimNext();
      // Guard: stop() may have been called during the claim request.
      if (stopped) return;
      if (run) {
        executeRun(run); // don't await — fire and forget
      }
    } finally {
      pollInFlight = false;
    }
  }

  // ── Start / stop ────────────────────────────────────────────
  pollTimer = setInterval(poll, config.pollIntervalMs);
  if ("unref" in pollTimer) (pollTimer as NodeJS.Timeout).unref();
  notifyStatus();
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
      const ctx = currentContext;
      if (ctx && !ctx.leaseLost) {
        signalLeaseLost(ctx, "poller stopped");
      }
      // Don't null currentContext here — the executeRun finally block
      // owns teardown.  Tests wait for status to become idle.
    },
  };
}
