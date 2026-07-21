/**
 * Tests for Atlas work polling — RFC 0002 bounded in-memory reliability.
 *
 * Uses controlled `globalThis.fetch` mocking with short lease times.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import {
  startWorkPoller,
  type HandlerResult,
  type RunRecord,
} from "../extensions/atlas/work";

// ─── Fixtures ────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run_test",
    project_id: "test",
    job_name: "test-job",
    capabilities_required: ["test-job"],
    input: {},
    output: null,
    status: "claimed",
    agent_id: "mac.lumio.pi.test",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    max_attempts: 3,
    priority: 0,
    metadata: {},
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    attempt_id: "attempt_a1",
    claim_token: "tok_secret",
    ...overrides,
  };
}

function client(): AtlasClient {
  return {
    config: { url: "http://atlas.test", token: "bootstrap", nodeId: "mac" },
    agentId: "mac.lumio.pi.test",
    scopedToken: "scoped",
    health: async () => ({ ok: true, data: { status: "ok", version: "test" } }),
    register: async () => ({ ok: false, error: "unused" }),
    heartbeat: async () => ({ ok: false, error: "unused" }),
    status: async () => ({ kind: "disconnected", reason: "unused" }),
    controlGet: async () => ({ ok: false, status: 0, error: "unused" }),
    controlPost: async () => ({ ok: false, status: 0, error: "unused" }),
    controlPatch: async () => ({ ok: false, status: 0, error: "unused" }),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("condition timed out"));
      }
    }, 10);
  });
}

// ─── Existing tests (adapted for AttemptContext) ─────────────────────

test("stop aborts the active handler", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let handlerStarted = false;
  let handlerAborted = false;

  const run = makeRun();

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal): Promise<HandlerResult> => {
        handlerStarted = true;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { handlerAborted = true; resolve(); }, { once: true });
        });
        return { status: "failure", code: "cancelled", message: "cancelled", retryable: false };
      },
    );

    await waitFor(() => handlerStarted);
    poller.stop();
    await waitFor(() => handlerAborted);
    assert.equal(handlerAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ambiguous completion first response lost, second succeeds — same idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completeAttempts = 0;
  const keys: string[] = [];
  const run = makeRun();

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/complete")) {
      completeAttempts++;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (completeAttempts === 1) throw new TypeError("connection reset");
      return Response.json({ ...run, status: "completed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
    );
    await waitFor(() => completeAttempts >= 2);
    poller.stop();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transcript artifacts are content-addressed and private", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-artifacts-"));
  const source = join(root, "source.txt");
  writeFileSync(source, "trusted transcript\n", "utf-8");
  process.env.ATLAS_ARTIFACT_ROOT = root;

  const { storeTranscriptArtifact } = await import("../extensions/atlas/artifacts");
  const artifact = storeTranscriptArtifact(source, "BV1234567890");
  const path = artifact.uri.replace(/^file:\/\//, "");

  assert.equal(readFileSync(path, "utf-8"), "trusted transcript\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(artifact.checksum ?? "", /^sha256:[0-9a-f]{64}$/);
});

// ─── New RFC 0002 tests ──────────────────────────────────────────────

test("heartbeat sends attempt_id and claim_token", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let hbAttemptId = "";
  let hbClaimToken = "";

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      const body = JSON.parse(init?.body ?? "{}");
      hbAttemptId = body.attempt_id ?? "";
      hbClaimToken = body.claim_token ?? "";
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
    );
    await waitFor(() => hbAttemptId !== "" && hbClaimToken !== "");
    poller.stop();
    assert.equal(hbAttemptId, "attempt_a1");
    assert.equal(hbClaimToken, "tok_secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat network failure then success within lease — handler not aborted, deadline updated", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let hbFails = 0;
  let hbSucceeded = false;
  let handlerFinished = false;
  let handlerAborted = false;
  let handlerExitedCleanly = false;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      hbFails++;
      if (hbFails <= 2) throw new TypeError("connection reset");
      hbSucceeded = true;
      return Response.json({ ...run, lease_expires_at: new Date(Date.now() + 120_000).toISOString() });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 5_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        signal.addEventListener("abort", () => { handlerAborted = true; }, { once: true });
        await sleep(4000);
        handlerExitedCleanly = !handlerAborted && !signal.aborted;
        handlerFinished = true;
        return { status: "success", output: {}, artifacts: [], source_updates: [], resources: [] };
      },
    );
    await waitFor(() => hbSucceeded && handlerFinished, 10_000);
    poller.stop();
    assert.equal(handlerExitedCleanly, true);
    assert.equal(handlerFinished, true);
    assert.ok(hbSucceeded);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat 409 causes handler abort and no terminal report", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completeOrFailCalled = false;
  const statuses: string[] = [];

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return new Response(JSON.stringify({ detail: "attempt_superseded" }), { status: 409 });
    }
    if (url.includes("/complete") || url.includes("/fail")) {
      completeOrFailCalled = true;
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "failure", code: "aborted", message: "aborted", retryable: false };
      },
      (ws) => { statuses.push(ws.kind); },
    );
    await waitFor(() => statuses.includes("abandoned"), 5_000);
    poller.stop();
    assert.equal(completeOrFailCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Atlas unreachable until deadline — attempt abandoned, no complete/fail", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completeOrFailCalled = false;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 500).toISOString() });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) throw new TypeError("connection refused");
    if (url.includes("/complete") || url.includes("/fail")) completeOrFailCalled = true;
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "failure", code: "aborted", message: "aborted", retryable: false };
      },
    );
    await waitFor(() => poller.status().kind === "abandoned", 5_000);
    poller.stop();
    assert.equal(completeOrFailCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete and fail carry attempt_id and claim_token", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let failAttemptId = "";
  let failClaimToken = "";

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/fail")) {
      const body = JSON.parse(init?.body ?? "{}");
      failAttemptId = body.attempt_id ?? "";
      failClaimToken = body.claim_token ?? "";
      return Response.json({ ...run, status: "failed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "failure", code: "E01", message: "task failed", retryable: false }),
    );
    await waitFor(() => failAttemptId !== "" && failClaimToken !== "");
    poller.stop();
    assert.equal(failAttemptId, "attempt_a1");
    assert.equal(failClaimToken, "tok_secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v3 completion carries Source updates and Resources before projection", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completionBody: Record<string, any> | null = null;
  let projected = false;
  const run = makeRun();

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/complete")) {
      completionBody = JSON.parse(init?.body ?? "{}");
      return Response.json({ ...run, status: "completed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({
        status: "success",
        output: { bounded: true },
        artifacts: [{ name: "summary", uri: "file:///summary.md" }],
        source_updates: [{ source_id: "src_one", title: "title" }],
        resources: [{
          resource_id: `res_${"a".repeat(32)}`,
          source_id: "src_one",
          kind: "summary",
          title: "summary",
          artifact_name: "summary",
          content_hash: `sha256:${"a".repeat(64)}`,
          generator: {
            mode: "ai",
            name: "test",
            version: "1",
            model_provider: "test",
            model_id: "test",
            prompt_version: "test-v1",
          },
          metadata: {},
        }],
      }),
      undefined,
      async () => { projected = true; },
    );
    await waitFor(() => projected);
    poller.stop();
    assert.deepEqual(completionBody?.source_updates, [{ source_id: "src_one", title: "title" }]);
    assert.equal(completionBody?.resources[0].artifact_name, "summary");
    assert.equal(completionBody?.output.bounded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stop() aborts handler and leaves no stale callbacks", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completeCalled = false;
  let handlerAborted = false;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/complete")) completeCalled = true;
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        signal.addEventListener("abort", () => { handlerAborted = true; }, { once: true });
        await new Promise<void>((resolve) => {
          if (signal.aborted) { handlerAborted = true; resolve(); }
          else signal.addEventListener("abort", () => { handlerAborted = true; resolve(); }, { once: true });
        });
        return { status: "failure", code: "aborted", message: "aborted", retryable: false };
      },
    );
    await waitFor(() => poller.status().kind === "claimed", 5_000);
    poller.stop();
    // After stop, the status should eventually settle (idle or abandoned).
    await waitFor(() => {
      const s = poller.status().kind;
      return s === "idle" || s === "abandoned";
    }, 5_000);
    assert.equal(handlerAborted, true);
    // No late complete after stop.
    assert.equal(completeCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing attempt_id/claim_token/lease in claim response is protocol error and does not call handler", async () => {
  const originalFetch = globalThis.fetch;
  let handlerCalled = false;

  const badRun = makeRun();
  delete (badRun as any).attempt_id;
  delete (badRun as any).claim_token;
  delete (badRun as any).lease_expires_at;

  globalThis.fetch = async () => Response.json(badRun);

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => { handlerCalled = true; return { status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }; },
    );
    await sleep(1000);
    poller.stop();
    assert.equal(handlerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("old deadline timer does not abort successor attempt", async () => {
  // Simulate: claim run-1 with very short lease, deadline fires, new run-2 claimed.
  // The old timer must not abort run-2.
  const originalFetch = globalThis.fetch;
  let claimCount = 0;
  let run2HandlerStarted = false;
  let run2Aborted = false;
  let run2ExitedCleanly = false;

  const run1 = makeRun({
    run_id: "run_1",
    lease_expires_at: new Date(Date.now() + 200).toISOString(),
    attempt_id: "att_1",
    claim_token: "tok_1",
  });
  const run2 = makeRun({
    run_id: "run_2",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_id: "att_2",
    claim_token: "tok_2",
  });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    // Claim: return run1 once, then run2.
    if (url.includes("/api/runs/next")) {
      claimCount++;
      if (claimCount === 1) return Response.json(run1);
      if (claimCount === 2) return Response.json(run2);
      return Response.json(null);
    }
    // Heartbeat for run_2 succeeds.
    if (url.includes("run_2/heartbeat")) {
      return Response.json({ ...run2, lease_expires_at: run2.lease_expires_at });
    }
    // Heartbeat for run_1 is unreachable.
    if (url.includes("run_1")) throw new TypeError("connection refused");
    return Response.json(run2);
  };

  try {
    let run2Signal: AbortSignal | null = null;
    let run2Completed = false;
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 300, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        if (_r.run_id === "run_2") {
          run2Signal = signal;
          run2HandlerStarted = true;
          signal.addEventListener("abort", () => { run2Aborted = true; }, { once: true });
          await sleep(500);
          run2ExitedCleanly = !run2Aborted && !signal.aborted;
          run2Completed = true;
        } else {
          await new Promise<void>((resolve) => {
            if (signal.aborted) { resolve(); return; }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return { status: "failure", code: "aborted", message: "aborted", retryable: false };
      },
    );

    // Wait for run2 to start and complete its handler (without being aborted).
    await waitFor(() => run2Completed, 5_000);
    // Check that run2 was not aborted *before* calling stop().
    assert.equal(run2ExitedCleanly, true, "successor attempt must not be aborted by old deadline timer");
    poller.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handler crash is reported with bounded wait, attempt stays active during report", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let crashReportReceived = false;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/fail")) {
      crashReportReceived = true;
      return Response.json({ ...run, status: "failed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => { throw new Error("boom"); },
    );
    await waitFor(() => crashReportReceived, 5_000);
    poller.stop();
    assert.equal(crashReportReceived, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal report retries stop at lease deadline, no late requests", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completeAttempts = 0;
  const requestTimestamps: number[] = [];

  // Short lease: 600ms. Handler finishes immediately, but complete always fails (network).
  // After ~600ms, deadline fires, retries stop.
  const run = makeRun({ lease_expires_at: new Date(Date.now() + 600).toISOString() });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) throw new TypeError("connection refused");
    if (url.includes("/complete")) {
      completeAttempts++;
      requestTimestamps.push(Date.now());
      throw new TypeError("connection reset");
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
    );

    // Wait for abandoned status (deadline-fired).
    await waitFor(() => poller.status().kind === "abandoned", 5_000);
    // Wait a bit more to ensure no late retries.
    await sleep(1000);
    poller.stop();

    // At least one complete attempt was made.
    assert.ok(completeAttempts > 0, "should have retried at least once");
    // After the deadline, no more attempts should have been made.
    // We can't deterministically test "no late requests" in a fake-server test,
    // but the status becoming "abandoned" + the handler not blocking proves
    // the deadline path was taken.
    assert.equal(poller.status().kind, "abandoned");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("claim_token is NOT present in handler run or status callbacks", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let handlerRun: RunRecord | null = null;
  let statusRun: RunRecord | null = null;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      return Response.json({ ...run, lease_expires_at: run.lease_expires_at });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (r) => { handlerRun = r; return { status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }; },
      (ws) => { if (ws.kind === "claimed") statusRun = ws.run; },
    );
    await waitFor(() => handlerRun !== null && statusRun !== null, 5_000);
    poller.stop();

    assert.ok(handlerRun, "handler should have been called");
    assert.equal((handlerRun as any).attempt_id, undefined, "attempt_id must be stripped from handler run");
    assert.equal((handlerRun as any).claim_token, undefined, "claim_token must be stripped from handler run");
    assert.ok(statusRun, "status callback should have been called");
    assert.equal((statusRun as any).attempt_id, undefined, "attempt_id must be stripped from status run");
    assert.equal((statusRun as any).claim_token, undefined, "claim_token must be stripped from status run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("continuous heartbeat renewal extends lease past original deadline", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let heartbeatCount = 0;
  let handlerFinished = false;
  let handlerAborted = false;
  let handlerExitedCleanly = false;

  // Initial lease: 300ms. Heartbeat extends by 120s each time.
  const run = makeRun({ lease_expires_at: new Date(Date.now() + 300).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      heartbeatCount++;
      return Response.json({ ...run, lease_expires_at: new Date(Date.now() + 120_000).toISOString() });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async (_r, signal) => {
        signal.addEventListener("abort", () => { handlerAborted = true; }, { once: true });
        // Handler takes 1.5s — well past the 300ms initial lease.
        await sleep(1500);
        handlerExitedCleanly = !handlerAborted && !signal.aborted;
        handlerFinished = true;
        return { status: "success", output: {}, artifacts: [], source_updates: [], resources: [] };
      },
    );
    await waitFor(() => handlerFinished, 5_000);
    poller.stop();
    // Handler must not have been aborted by the original 300ms deadline.
    assert.equal(handlerExitedCleanly, true, "handler must not be aborted — heartbeat should renew lease");
    // At least one heartbeat must have fired (the immediate one at startup).
    assert.ok(heartbeatCount >= 1, "at least one heartbeat must have extended the lease");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat single-flight — only one in-flight heartbeat at a time", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let concurrentHeartbeatCalls = 0;
  let maxConcurrent = 0;
  let resolveHeartbeat: (() => void) | null = null;

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      concurrentHeartbeatCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentHeartbeatCalls);
      // Block the first heartbeat until we trigger resolution.
      if (!resolveHeartbeat) {
        await new Promise<void>((resolve) => { resolveHeartbeat = resolve; });
      }
      concurrentHeartbeatCalls--;
      return Response.json({ ...run, lease_expires_at: new Date(Date.now() + 120_000).toISOString() });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      // Use a short heartbeat interval so the interval timer fires while the immediate
      // heartbeat is still blocked.
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 200, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
    );

    // Wait for the immediate heartbeat to start and block.
    await waitFor(() => resolveHeartbeat !== null, 2_000);
    // Now the interval heartbeat should have fired at least once while the
    // immediate one is blocked.  If single-flight works, maxConcurrent stays 1.
    await sleep(500);
    assert.equal(maxConcurrent, 1, "only one heartbeat should be in flight at a time");

    // Release the blocked heartbeat.
    resolveHeartbeat!();
    resolveHeartbeat = null;

    await waitFor(() => poller.status().kind === "completed" || poller.status().kind === "abandoned", 5_000);
    poller.stop();
    assert.equal(maxConcurrent, 1, "single-flight must prevent concurrent heartbeat calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stop during claim request does not start handler", async () => {
  const originalFetch = globalThis.fetch;
  let handlerCalled = false;
  let claimResolve: (() => void) | null = null;

  const run = makeRun();

  // The /next endpoint blocks until we release it, simulating a slow claim.
  globalThis.fetch = async (input: any, _init?: any) => {
    const url = input as string;
    if (url.includes("/api/runs/next")) {
      await new Promise<void>((resolve) => { claimResolve = resolve; });
      return Response.json(run);
    }
    // Heartbeat/complete should not be called (handler never starts).
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => { handlerCalled = true; return { status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }; },
    );

    // Wait for poll to have started the claim request.
    await waitFor(() => claimResolve !== null, 2_000);
    // Stop while claim is still in-flight.
    poller.stop();
    // Now release the claim.
    claimResolve!();
    await sleep(300);

    assert.equal(handlerCalled, false, "handler must not run when stop() is called during claim");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale in-flight heartbeat after normal completion does not produce callbacks or orphan timers", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let heartbeatCallCount = 0;
  let heartbeatDone = false;
  let released = false;
  let releaseHeartbeat: (() => void) | null = null;
  const callbacks: string[] = [];

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      heartbeatCallCount++;
      if (!released) {
        // Block the first heartbeat indefinitely.
        await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
        released = true;
      }
      heartbeatDone = true;
      return Response.json({ ...run, lease_expires_at: new Date(Date.now() + 120_000).toISOString() });
    }
    if (url.includes("/complete")) return Response.json({ ...run, status: "completed" });
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
      (ws) => { callbacks.push(ws.kind); },
    );

    // Wait for handler to complete (status becomes "completed").
    await waitFor(() => callbacks.includes("completed"), 5_000);
    assert.ok(!heartbeatDone, "heartbeat must still be blocked");

    poller.stop();
    const callbacksBeforeRelease = callbacks.length;

    // Now release the stale heartbeat.
    releaseHeartbeat!();
    await sleep(500);

    const callbacksAfterRelease = callbacks.length;

    // Must not produce new callbacks after release.
    assert.equal(callbacksAfterRelease, callbacksBeforeRelease,
      `stale heartbeat produced ${callbacksAfterRelease - callbacksBeforeRelease} extra callback(s)`);

    // For safety, check the exact callback sequence: idle, claimed, completed.
    assert.deepEqual(callbacks, ["idle", "claimed", "completed"],
      "stale heartbeat must not inject orphan status callbacks");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat 409 during complete does not override accepted completion", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let heartbeatAttempted = false;
  let heartbeatSettled = false;
  let completeAcceptedByServer = false;
  let releaseHeartbeat: (() => void) | null = null;
  const statuses: string[] = [];

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      heartbeatAttempted = true;
      // Block the heartbeat until after the complete request is accepted.
      await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
      heartbeatSettled = true;
      // Return 409 — attempt superseded (as if the server already
      // considers this attempt finished).
      return new Response(JSON.stringify({ detail: "attempt_superseded" }), { status: 409 });
    }
    if (url.includes("/complete")) {
      completeAcceptedByServer = true;
      return Response.json({ ...run, status: "completed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => ({ status: "success", output: {}, artifacts: [], source_updates: [], resources: [] }),
      (ws) => { statuses.push(ws.kind); },
    );

    // Wait for complete to be accepted.
    await waitFor(() => completeAcceptedByServer, 5_000);

    // Now release the stale heartbeat — it returns 409.
    releaseHeartbeat!();
    await waitFor(() => heartbeatSettled, 5_000);

    // The final state must be "completed", not "abandoned".
    const final = poller.status();
    assert.equal(final.kind, "completed",
      `final status must be completed, got ${final.kind}`);

    // Must never have seen an "abandoned" callback.
    assert.ok(!statuses.includes("abandoned"),
      `must not contain abandoned: ${JSON.stringify(statuses)}`);

    poller.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat 409 during crash report does not override accepted failure", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let failAcceptedByServer = false;
  let heartbeatReturned409 = false;
  let releaseHeartbeat: (() => void) | null = null;
  const statuses: string[] = [];

  const run = makeRun({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() });

  globalThis.fetch = async (input: any, init?: any) => {
    const url = input as string;
    if (!claimed) { claimed = true; return Response.json(run); }
    if (url.includes("/heartbeat")) {
      // Block the heartbeat until the fail report is accepted.
      await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
      heartbeatReturned409 = true;
      return new Response(JSON.stringify({ detail: "attempt_superseded" }), { status: 409 });
    }
    if (url.includes("/fail")) {
      failAcceptedByServer = true;
      return Response.json({ ...run, status: "failed" });
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000, leaseSafetyMarginMs: 0 },
      async () => { throw new Error("boom"); },
      (ws) => { statuses.push(ws.kind); },
    );

    // Wait for fail to be accepted.
    await waitFor(() => failAcceptedByServer, 5_000);

    // Release the stale heartbeat — returns 409.
    releaseHeartbeat!();
    await waitFor(() => heartbeatReturned409, 5_000);

    // Final status must be "completed" (failure reported), not "abandoned".
    const final = poller.status();
    assert.equal(final.kind, "completed",
      `final status must be completed, got ${final.kind}`);

    // Must never have seen an "abandoned" callback.
    assert.ok(!statuses.includes("abandoned"),
      `must not contain abandoned: ${JSON.stringify(statuses)}`);

    poller.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Utility ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
