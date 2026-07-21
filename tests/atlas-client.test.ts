import assert from "node:assert/strict";
import test from "node:test";

import {
  createClient,
  buildRunnerRegistration,
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

test("Lumio registers only its interaction adapter, not a generic Pi executor", () => {
  const previous = process.env.LUMIO_AGENT_MODE;
  process.env.LUMIO_AGENT_MODE = "background";
  try {
    assert.equal(generateAgentName(config), "Lumio background pi on macsp");
    const registration = buildRunnerRegistration(
      config,
      "macsp.lumio.nightly",
      generateAgentName(config),
      ["bilibili-summary-v4"],
      "nightly",
    );
    assert.equal(registration.node.node_id, "macsp");
    assert.equal(registration.executors[0]?.name, "lumio-interactive");
    assert.equal(registration.metadata.runner_mode, "background");
    assert.deepEqual(registration.legacy_capabilities, ["bilibili-summary-v4"]);
  } finally {
    if (previous === undefined) delete process.env.LUMIO_AGENT_MODE;
    else process.env.LUMIO_AGENT_MODE = previous;
  }
});

test("Lumio refuses an Atlas server that does not acknowledge runner v1", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    runner_id: "macsp.lumio.test",
    scoped_token: "at2_secret",
    protocol_version: "atlas-agent-v3",
  });

  try {
    const client = createClient(config, "test-session");
    const result = await client.register(
      buildRunnerRegistration(config, client.agentId, "test", []),
    );
    assert.equal(result.ok, false);
    assert.equal(client.scopedToken, null);
    if (!result.ok) assert.match(result.error, /protocol mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lumio accepts runner v1 registration and stores only the scoped work credential", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    runner_id: "macsp.lumio.testsession",
    scoped_token: "at2_scoped-secret",
    protocol_version: "atlas-runner-v1",
  });

  try {
    const client = createClient(config, "test-session");
    const result = await client.register(
      buildRunnerRegistration(config, client.agentId, "test", ["bilibili-summary-v4"]),
    );
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
