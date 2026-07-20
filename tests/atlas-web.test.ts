import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { webSummaryHandler } from "../extensions/atlas/jobs/web";
import {
  captureWebPage,
  startWebCaptureServer,
  webCaptureNodeCapability,
} from "../extensions/atlas/web-capture";
import type { RunRecord } from "../extensions/atlas/work";

function run(input: Record<string, unknown>): RunRecord {
  return {
    run_id: "run_web_1",
    project_id: "web-capture",
    job_name: "web-summary-v1",
    capabilities_required: ["web-summary-v1", "web-capture-node:test-node"],
    input,
    output: null,
    status: "claimed",
    agent_id: "test-node.lumio.test",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    attempt_number: 1,
    max_attempts: 3,
    priority: 5,
    metadata: {},
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

test("Send to Atlas stores extraction outside Run input body and publishes normal summary resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-web-"));
  const previous = process.env.ATLAS_ARTIFACT_ROOT;
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const posts: Array<{ path: string; body: any }> = [];
  const client = {
    config: { url: "http://atlas.test", token: "secret", nodeId: "test-node" },
    agentId: "test-node.lumio.test",
    scopedToken: "scoped",
    async controlPost(path: string, body: unknown) {
      posts.push({ path, body });
      if (path === "/api/sources") return { ok: true as const, data: { source_id: "src_web_1" } };
      if (path === "/api/runs/enqueue") return { ok: true as const, data: run((body as any).input) };
      return { ok: true as const, data: {} };
    },
  } as unknown as AtlasClient;

  try {
    const result = await captureWebPage(client, {
      url: "https://example.com/article#section",
      title: "Example article",
      markdown: "# Example article\n\nA sufficiently long captured article body.",
      captured_at: "2026-07-20T10:00:00.000Z",
    });
    assert.equal(result.source_id, "src_web_1");
    const sourcePost = posts.find((item) => item.path === "/api/sources")!;
    assert.equal(sourcePost.body.kind, "webpage");
    const enqueue = posts.find((item) => item.path === "/api/runs/enqueue")!;
    assert.deepEqual(enqueue.body.capabilities_required, [
      "web-summary-v1",
      webCaptureNodeCapability("test-node"),
    ]);
    assert.equal(JSON.stringify(enqueue.body).includes("sufficiently long captured"), false);
    assert.equal(enqueue.body.input.url, "https://example.com/article");

    const extraction = enqueue.body.input.extraction;
    assert.equal(readFileSync(new URL(extraction.uri), "utf-8").includes("captured article body"), true);
    assert.equal(statSync(new URL(extraction.uri)).mode & 0o777, 0o600);

    const handled = await webSummaryHandler(
      run(enqueue.body.input),
      new AbortController().signal,
      async () => ({
        markdown: "# 内容概览\n\nA compact summary.",
        generator: { mode: "ai", name: "test-web-summary", version: "1" },
        metadata: { chunk_count: 1 },
      }),
    );
    assert.equal(handled.status, "success");
    if (handled.status !== "success") return;
    assert.deepEqual(handled.resources.map((resource) => resource.kind), ["extraction", "summary"]);
    assert.equal(handled.artifacts.length, 2);
    assert.equal(JSON.stringify(handled.output).includes("captured article body"), false);
    assert.equal(handled.resources[1].metadata.extraction_resource_id, handled.resources[0].resource_id);
  } finally {
    if (previous === undefined) delete process.env.ATLAS_ARTIFACT_ROOT;
    else process.env.ATLAS_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("web summary rejects an extraction outside ATLAS_ARTIFACT_ROOT", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-web-root-"));
  const outside = mkdtempSync(join(tmpdir(), "lumio-web-outside-"));
  const previous = process.env.ATLAS_ARTIFACT_ROOT;
  process.env.ATLAS_ARTIFACT_ROOT = root;
  try {
    const handled = await webSummaryHandler(
      run({
        source_id: "src_web_2",
        url: "https://example.com/",
        title: "Outside artifact",
        captured_at: new Date().toISOString(),
        extraction: {
          name: "outside",
          uri: new URL(`file://${outside}/page.md`).href,
          checksum: `sha256:${"0".repeat(64)}`,
        },
      }),
      new AbortController().signal,
      async () => { throw new Error("must not summarize"); },
    );
    assert.equal(handled.status, "failure");
    if (handled.status === "failure") assert.equal(handled.code, "extraction_unavailable");
  } finally {
    if (previous === undefined) delete process.env.ATLAS_ARTIFACT_ROOT;
    else process.env.ATLAS_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("loopback bridge accepts only the dedicated Chrome-extension request shape", async () => {
  const calls: unknown[] = [];
  const client = {
    config: { url: "http://atlas.test", token: "secret", nodeId: "test-node" },
    agentId: "test-node.lumio.test",
    scopedToken: "scoped",
    async controlPost(path: string, body: unknown) {
      calls.push({ path, body });
      if (path === "/api/sources") return { ok: true as const, data: { source_id: "src_bridge" } };
      if (path === "/api/runs/enqueue") return { ok: true as const, data: run((body as any).input) };
      return { ok: true as const, data: {} };
    },
  } as unknown as AtlasClient;
  const root = mkdtempSync(join(tmpdir(), "lumio-web-bridge-"));
  const previous = process.env.ATLAS_ARTIFACT_ROOT;
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const server = await startWebCaptureServer(() => client, { port: 0 });
  assert.ok(server);
  try {
    const rejected = await fetch(`http://127.0.0.1:${server.port}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lumio-Capture": "1", Origin: "https://example.com" },
      body: JSON.stringify({ url: "https://example.com", title: "Example", markdown: "A long enough page extraction for Atlas." }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`http://127.0.0.1:${server.port}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lumio-Capture": "1",
        Origin: `chrome-extension://${"a".repeat(32)}`,
      },
      body: JSON.stringify({ url: "https://example.com", title: "Example", markdown: "A long enough page extraction for Atlas." }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).ok, true);
    assert.equal(calls.length, 3);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.ATLAS_ARTIFACT_ROOT;
    else process.env.ATLAS_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
