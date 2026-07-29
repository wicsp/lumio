import assert from "node:assert/strict";
import test from "node:test";

import {
  createClient,
  parseConfig,
  type AtlasConfig,
} from "../extensions/atlas/client";

const config: AtlasConfig = {
  url: "http://atlas.test",
  token: "bootstrap-token",
  nodeId: "macsp",
};

test("createClient returns a usable client without registration", () => {
  const client = createClient(config);
  assert.equal(client.config.url, "http://atlas.test");
  assert.equal(client.config.token, "bootstrap-token");
  assert.equal(client.config.nodeId, "macsp");
});

test("health returns status when Atlas is reachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: "ok", version: "0.1.0" });

  try {
    const client = createClient(config);
    const result = await client.health();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.status, "ok");
      assert.equal(result.data.version, "0.1.0");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status returns disconnected when health fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  try {
    const client = createClient(config);
    const status = await client.status();
    assert.equal(status.kind, "disconnected");
    if (status.kind === "disconnected") {
      assert.match(status.reason, /ECONNREFUSED/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status returns connected with health info", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: "ok", version: "0.1.0" });

  try {
    const client = createClient(config);
    const status = await client.status();
    assert.equal(status.kind, "connected");
    if (status.kind === "connected") {
      assert.equal(status.health.status, "ok");
      assert.equal(status.health.version, "0.1.0");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Atlas validation errors preserve the response body and are not retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(
      { detail: [{ loc: ["body", "kind"], msg: "Input should be 'webpage'", type: "literal_error" }] },
      { status: 422 },
    );
  };

  try {
    const client = createClient(config);
    const result = await client.controlPost("/api/sources", { kind: "web_page" });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    if (!result.ok) {
      assert.equal(result.status, 422);
      assert.match(result.error, /Input should be 'webpage'/);
      assert.doesNotMatch(result.error, /unreachable/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
