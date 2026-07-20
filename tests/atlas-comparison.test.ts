import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { createComparisonHandler } from "../extensions/atlas/comparison";
import { storeSummaryArtifact } from "../extensions/atlas/jobs/bilibili";
import type { AtlasResourceRecord, AtlasSourceRecord } from "../extensions/atlas/obsidian";
import type { PiSummaryRuntime } from "../extensions/atlas/summarize";
import type { ArtifactRef, RunRecord } from "../extensions/atlas/work";

function run(resourceId: unknown): RunRecord {
  return {
    run_id: "run_compare",
    project_id: "resource-review",
    job_name: "vortex-comparison-v1",
    capabilities_required: ["vortex-comparison-v1"],
    input: { resource_id: resourceId },
    output: null,
    status: "claimed",
    agent_id: "agt_test",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    attempt_number: 1,
    max_attempts: 2,
    priority: 20,
    metadata: {},
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

test("comparison rejects invalid input before accessing runtime", async () => {
  const handler = createComparisonHandler(() => null, () => null);
  const result = await handler(run("not-a-resource"), new AbortController().signal);
  assert.deepEqual(result, {
    status: "failure",
    code: "invalid_input",
    message: "Invalid resource_id",
    retryable: false,
  });
});

test("comparison refuses to invent friction when there are no written comments", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-comparison-"));
  process.env.ATLAS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.ATLAS_OBSIDIAN_VAULT = join(root, "Vortex");
  const artifact = storeSummaryArtifact("# Summary\n", "BV1234567890");
  const resource: AtlasResourceRecord = {
    resource_id: `res_${"a".repeat(32)}`,
    source_id: `src_${"b".repeat(32)}`,
    produced_by_run_id: "run_source",
    artifact_id: "art_source",
    kind: "summary",
    title: "Summary",
    content_hash: artifact.checksum!,
    generator: {
      mode: "ai",
      name: "test",
      version: "1",
      model_provider: "openai",
      model_id: "test",
      prompt_version: "test-v1",
    },
    metadata: { profile_id: "overview-v1" },
    review_status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const source: AtlasSourceRecord = {
    source_id: resource.source_id,
    source_key: "test:source",
    kind: "other",
    canonical_uri: "https://example.test/source",
    title: "Source",
    external_ids: {},
    metadata: {},
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
  const artifactRef: ArtifactRef = {
    artifact_id: resource.artifact_id,
    run_id: resource.produced_by_run_id,
    name: artifact.name,
    uri: artifact.uri,
    content_type: artifact.content_type ?? null,
    size_bytes: artifact.size_bytes ?? null,
    checksum: artifact.checksum ?? null,
    created_at: resource.created_at,
  };
  const client: Pick<AtlasClient, "controlGet"> = {
    async controlGet<T>(path: string) {
      if (path.endsWith("/bundle")) {
        return { ok: true as const, data: { resource, source, artifact: artifactRef } as T };
      }
      if (path === "/api/knowledge-refs?limit=500") return { ok: true as const, data: [] as T };
      return { ok: false as const, status: 404, error: path };
    },
  };
  const handler = createComparisonHandler(
    () => client as AtlasClient,
    () => ({ model: {} as never, modelRegistry: {} as never }) as PiSummaryRuntime,
  );
  const result = await handler(run(resource.resource_id), new AbortController().signal);
  assert.equal(result.status, "failure");
  if (result.status === "failure") assert.equal(result.code, "no_human_comments");
});
