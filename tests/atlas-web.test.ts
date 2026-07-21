import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { captureWebPage, startWebCaptureServer } from "../extensions/atlas/web-capture";

function fakeClient(posts: Array<{ path: string; body: any }>): AtlasClient {
  return {
    config: { url: "http://atlas.test", token: "secret", nodeId: "macsp" },
    async controlPost(path: string, body: unknown) {
      posts.push({ path, body });
      if (path === "/api/sources") {
        return { ok: true as const, data: { source_id: "src_web_12345678" } };
      }
      if (path === "/api/workflow-invocations") {
        return {
          ok: true as const,
          data: { invocation_id: "wfi_1", step_runs: { summarize: "run_web_1" } },
        };
      }
      return { ok: false as const, status: 404, error: path };
    },
  } as unknown as AtlasClient;
}

test("web capture stores extraction and invokes the versioned Atlas workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-web-"));
  const previous = process.env.ATLAS_ARTIFACT_ROOT;
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const posts: Array<{ path: string; body: any }> = [];
  try {
    const result = await captureWebPage(fakeClient(posts), {
      url: "https://example.com/article#section",
      title: "Example article",
      markdown: "# Example article\n\nA sufficiently long captured article body.",
      captured_at: "2026-07-20T10:00:00.000Z",
    });

    assert.deepEqual(result, { source_id: "src_web_12345678", run_id: "run_web_1" });
    const invocation = posts.find((item) => item.path === "/api/workflow-invocations")!;
    assert.equal(invocation.body.workflow_name, "web.summary");
    assert.equal(invocation.body.workflow_version, "1");
    assert.equal(JSON.stringify(invocation.body).includes("captured article body"), false);
    assert.match(
      readFileSync(new URL(invocation.body.input.extraction.uri), "utf-8"),
      /captured article body/,
    );
  } finally {
    if (previous === undefined) delete process.env.ATLAS_ARTIFACT_ROOT;
    else process.env.ATLAS_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("loopback bridge remains a pure interaction entrypoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-web-bridge-"));
  const previous = process.env.ATLAS_ARTIFACT_ROOT;
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const posts: Array<{ path: string; body: any }> = [];
  const server = await startWebCaptureServer(() => fakeClient(posts), { port: 0 });
  assert.ok(server);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lumio-Capture": "1",
        Origin: `chrome-extension://${"a".repeat(32)}`,
      },
      body: JSON.stringify({
        url: "https://example.com",
        title: "Example",
        markdown: "A long enough page extraction for Atlas.",
      }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(posts.map((item) => item.path), [
      "/api/sources",
      "/api/workflow-invocations",
    ]);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.ATLAS_ARTIFACT_ROOT;
    else process.env.ATLAS_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
