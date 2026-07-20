import assert from "node:assert/strict";
import test from "node:test";

import {
  createClient,
  buildMetadata,
  generateAgentId,
  generateAgentName,
  type AtlasConfig,
} from "../extensions/atlas/client";

const config: AtlasConfig = {
  url: "http://atlas.test",
  token: "bootstrap-token",
  nodeId: "macsp",
};

test("agent identity is one Lumio executor using Pi's real session instance", () => {
  assert.equal(
    generateAgentId(config, "12345678-abcd-ef00-1122-334455667788"),
    "macsp.lumio.12345678abcdef00",
  );
});

test("headless queue executor is visible as one background Lumio agent", () => {
  const previous = process.env.LUMIO_AGENT_MODE;
  process.env.LUMIO_AGENT_MODE = "background";
  try {
    assert.equal(generateAgentName(config), "Lumio background pi on macsp");
    const metadata = buildMetadata(config, "nightly");
    assert.equal(metadata.agent_kind, "background");
    assert.equal(metadata.interactive, false);
    assert.equal(metadata.executor, "lumio");
    assert.equal(metadata.runtime, "pi");
  } finally {
    if (previous === undefined) delete process.env.LUMIO_AGENT_MODE;
    else process.env.LUMIO_AGENT_MODE = previous;
  }
});

test("Lumio refuses an Atlas server that does not acknowledge v3", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    agent_id: "macsp.lumio.test",
    scoped_token: "at2_secret",
    protocol_version: "atlas-agent-v2",
  });

  try {
    const client = createClient(config, "test-session");
    const result = await client.register({
      agent_id: client.agentId,
      name: "test",
      capabilities: [],
      metadata: { protocol_version: "atlas-agent-v3" },
    });
    assert.equal(result.ok, false);
    assert.equal(client.scopedToken, null);
    if (!result.ok) assert.match(result.error, /protocol mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lumio accepts v3 registration and stores only the scoped work credential", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    agent_id: "macsp.lumio.testsession",
    scoped_token: "at2_scoped-secret",
    protocol_version: "atlas-agent-v3",
  });

  try {
    const client = createClient(config, "test-session");
    const result = await client.register({
      agent_id: client.agentId,
      name: "test",
      capabilities: ["bilibili-summary"],
      metadata: { protocol_version: "atlas-agent-v3" },
    });
    assert.equal(result.ok, true);
    assert.equal(client.agentId, "macsp.lumio.testsession");
    assert.equal(client.scopedToken, "at2_scoped-secret");
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
    const client = createClient(config, "test-session");
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
