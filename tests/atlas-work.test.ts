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

const run: RunRecord = {
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
};

function client(): AtlasClient {
  return {
    config: { url: "http://atlas.test", token: "bootstrap", nodeId: "mac" },
    agentId: "mac.lumio.pi.test",
    scopedToken: "scoped",
    health: async () => ({ ok: true, data: { status: "ok", version: "test" } }),
    register: async () => ({ ok: false, error: "unused" }),
    heartbeat: async () => ({ ok: false, error: "unused" }),
    status: async () => ({ kind: "disconnected", reason: "unused" }),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("condition timed out"));
      }
    }, 10);
  });
}

test("stop aborts the active handler", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let handlerStarted = false;
  let handlerAborted = false;

  globalThis.fetch = async () => {
    if (!claimed) {
      claimed = true;
      return Response.json(run);
    }
    return Response.json(run);
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
      async (_run, signal): Promise<HandlerResult> => {
        handlerStarted = true;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            handlerAborted = true;
            resolve();
          }, { once: true });
        });
        return {
          status: "failure",
          code: "cancelled",
          message: "cancelled",
          retryable: false,
        };
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

test("ambiguous completion retry reuses one idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  let completionAttempts = 0;
  const keys: string[] = [];

  globalThis.fetch = async (_input, init) => {
    if (!claimed) {
      claimed = true;
      return Response.json(run);
    }

    completionAttempts += 1;
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (completionAttempts === 1) throw new TypeError("connection reset");
    return Response.json({ ...run, status: "completed" });
  };

  try {
    const poller = startWorkPoller(
      client(),
      { pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
      async () => ({ status: "success", output: { ok: true }, artifacts: [] }),
    );

    await waitFor(() => completionAttempts === 2);
    poller.stop();
    assert.equal(keys.length, 2);
    assert.ok(keys[0]);
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

  const { storeTranscriptArtifact } = await import(
    "../extensions/atlas/jobs/bilibili"
  );
  const artifact = storeTranscriptArtifact(source, "BV1234567890");
  const path = artifact.uri.replace(/^file:\/\//, "");

  assert.equal(readFileSync(path, "utf-8"), "trusted transcript\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(artifact.checksum ?? "", /^sha256:[0-9a-f]{64}$/);
});
