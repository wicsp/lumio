import assert from "node:assert/strict";
import test from "node:test";

import {
  createClient,
  generateAgentId,
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
