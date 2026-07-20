import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { vortexResourcePurgeHandler } from "../extensions/atlas/resource-purge";
import type { RunRecord } from "../extensions/atlas/work";

function checksum(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function purgeRun(resources: unknown[]): RunRecord {
  return {
    run_id: "run_purge",
    project_id: "resource-review",
    job_name: "vortex-resource-purge-v1",
    capabilities_required: ["vortex-resource-purge-v1"],
    input: { source_id: "src_12345678", resources },
    output: null,
    status: "claimed",
    agent_id: "macsp.lumio.test",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    max_attempts: 3,
    priority: 10,
    metadata: { requested_via: "atlas-console" },
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumio-purge-"));
  const artifactRoot = join(root, "artifacts");
  const vault = join(root, "Vortex");
  const artifactDir = join(artifactRoot, "resources", "source");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(join(vault, "Resources", "Cards"), { recursive: true });
  process.env.ATLAS_ARTIFACT_ROOT = artifactRoot;
  process.env.ATLAS_OBSIDIAN_VAULT = vault;
  return { root, artifactRoot, vault, artifactDir };
}

test("vortex-resource-purge-v1 deletes verified bytes and generated cards idempotently", async () => {
  const { vault, artifactDir } = fixture();
  const transcriptBody = "machine transcript";
  const summaryBody = "# machine summary";
  const transcriptPath = join(artifactDir, "transcript.txt");
  const summaryPath = join(artifactDir, "summary.md");
  const summaryId = `res_${"a".repeat(32)}`;
  writeFileSync(transcriptPath, transcriptBody);
  writeFileSync(summaryPath, summaryBody);
  const cardPath = join(vault, "Resources", "Cards", `${summaryId}.md`);
  writeFileSync(cardPath, "generated card");
  const run = purgeRun([
    {
      resource_id: `res_${"b".repeat(32)}`,
      kind: "transcript",
      artifact: {
        artifact_id: `art_${"b".repeat(32)}`,
        uri: `file://${transcriptPath}`,
        checksum: checksum(transcriptBody),
        size_bytes: Buffer.byteLength(transcriptBody),
      },
    },
    {
      resource_id: summaryId,
      kind: "summary",
      artifact: {
        artifact_id: `art_${"a".repeat(32)}`,
        uri: `file://${summaryPath}`,
        checksum: checksum(summaryBody),
        size_bytes: Buffer.byteLength(summaryBody),
      },
    },
  ]);

  const first = await vortexResourcePurgeHandler(run, new AbortController().signal);
  assert.equal(first.status, "success");
  assert.equal(existsSync(transcriptPath), false);
  assert.equal(existsSync(summaryPath), false);
  assert.equal(existsSync(cardPath), false);
  if (first.status === "success") {
    assert.equal(first.output.artifacts_removed, 2);
    assert.equal(first.output.cards_removed, 1);
  }

  const replay = await vortexResourcePurgeHandler(run, new AbortController().signal);
  assert.equal(replay.status, "success");
  if (replay.status === "success") {
    assert.equal(replay.output.artifacts_absent, 2);
    assert.equal(replay.output.cards_absent, 1);
  }
});

test("vortex-resource-purge-v1 refuses an artifact outside the configured root", async () => {
  const { root } = fixture();
  const outsidePath = join(root, "outside.md");
  const body = "must survive";
  writeFileSync(outsidePath, body);
  const run = purgeRun([
    {
      resource_id: `res_${"c".repeat(32)}`,
      kind: "summary",
      artifact: {
        artifact_id: `art_${"c".repeat(32)}`,
        uri: `file://${outsidePath}`,
        checksum: checksum(body),
        size_bytes: Buffer.byteLength(body),
      },
    },
  ]);

  const result = await vortexResourcePurgeHandler(run, new AbortController().signal);
  assert.equal(result.status, "failure");
  if (result.status === "failure") assert.equal(result.code, "artifact_outside_root");
  assert.equal(readFileSync(outsidePath, "utf-8"), body);
});

test("vortex-resource-purge-v1 preserves bytes when the checksum differs", async () => {
  const { artifactDir } = fixture();
  const path = join(artifactDir, "summary.md");
  writeFileSync(path, "changed");
  const run = purgeRun([
    {
      resource_id: `res_${"d".repeat(32)}`,
      kind: "summary",
      artifact: {
        artifact_id: `art_${"d".repeat(32)}`,
        uri: `file://${path}`,
        checksum: checksum("original"),
        size_bytes: null,
      },
    },
  ]);

  const result = await vortexResourcePurgeHandler(run, new AbortController().signal);
  assert.equal(result.status, "failure");
  if (result.status === "failure") assert.equal(result.code, "artifact_hash_mismatch");
  assert.equal(readFileSync(path, "utf-8"), "changed");
});
