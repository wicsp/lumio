import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { storeSummaryArtifact } from "../extensions/atlas/jobs/bilibili";
import type {
  AtlasResourceRecord,
  AtlasSourceRecord,
} from "../extensions/atlas/obsidian";
import {
  completeResourceComment,
  vortexCommentHandler,
} from "../extensions/atlas/resource-review";
import type { ArtifactRef, RunRecord } from "../extensions/atlas/work";

function run(resourceId: unknown): RunRecord {
  return {
    run_id: "run_comment",
    project_id: "resource-review",
    job_name: "vortex-comment-v1",
    capabilities_required: ["vortex-comment-v1"],
    input: { resource_id: resourceId },
    output: null,
    status: "claimed",
    agent_id: "agt_test",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    max_attempts: 3,
    priority: 0,
    metadata: { requested_via: "atlas-console" },
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc4-review-"));
  const artifactRoot = join(root, "artifacts");
  const vault = join(root, "Vortex");
  process.env.ATLAS_ARTIFACT_ROOT = artifactRoot;
  process.env.ATLAS_OBSIDIAN_VAULT = vault;
  const artifact = storeSummaryArtifact("# Machine summary\n\nNot human knowledge.\n", "BV1234567890");
  const resource: AtlasResourceRecord = {
    resource_id: `res_${"c".repeat(32)}`,
    source_id: "src_comment",
    produced_by_run_id: "run_summary",
    artifact_id: "art_summary",
    kind: "summary",
    title: "A summary awaiting judgment",
    content_hash: artifact.checksum!,
    generator: {
      mode: "ai",
      name: "lumio-test",
      version: "1",
      model_provider: "openai",
      model_id: "gpt-test",
      prompt_version: "test-v1",
    },
    metadata: {},
    review_status: "pending",
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
  };
  const source: AtlasSourceRecord = {
    source_id: resource.source_id,
    source_key: "bilibili:BV1234567890",
    kind: "video",
    canonical_uri: "https://www.bilibili.com/video/BV1234567890",
    title: "Review source",
    external_ids: { bvid: "BV1234567890" },
    metadata: {},
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
  const artifactRef: ArtifactRef = {
    artifact_id: resource.artifact_id,
    run_id: resource.produced_by_run_id,
    name: "summary",
    uri: artifact.uri,
    content_type: "text/markdown; charset=utf-8",
    size_bytes: artifact.size_bytes,
    checksum: artifact.checksum ?? null,
    created_at: resource.created_at,
  };
  return { vault, resource, source, artifactRef };
}

test("vortex-comment-v1 creates only a pending local draft and preserves human prose", async () => {
  const { vault, resource, source, artifactRef } = fixture();
  const knowledgePayloads: unknown[] = [];
  const reviewPayloads: unknown[] = [];
  const client: Pick<AtlasClient, "controlGet" | "controlPost" | "controlPatch"> = {
    async controlGet<T>(path: string) {
      assert.equal(path, `/api/resources/${resource.resource_id}/bundle`);
      return {
        ok: true as const,
        data: { resource, source, artifact: artifactRef } as T,
      };
    },
    async controlPost<T>(path: string, body: unknown) {
      assert.equal(path, "/api/knowledge-refs");
      knowledgePayloads.push(body);
      return { ok: true as const, data: { knowledge_ref_id: "kref_comment" } as T };
    },
    async controlPatch<T>(path: string, body: unknown) {
      assert.equal(path, `/api/resources/${resource.resource_id}/review`);
      reviewPayloads.push(body);
      return {
        ok: true as const,
        data: { ...resource, review_status: "reviewed" } as T,
      };
    },
  };

  const first = await vortexCommentHandler(
    run(resource.resource_id),
    new AbortController().signal,
    client,
  );
  assert.equal(first.status, "success");
  if (first.status !== "success") return;
  assert.equal(first.output.note_created, true);
  assert.equal(first.output.card_projection, "created");
  const noteId = String(first.output.note_id);
  const notePath = join(vault, `${noteId}.md`);
  const blank = readFileSync(notePath, "utf-8");
  const humanText = `${blank}\n这是我本人写下并负责的评论。\n`;
  writeFileSync(notePath, humanText, "utf-8");

  const replay = await vortexCommentHandler(
    run(resource.resource_id),
    new AbortController().signal,
    client,
  );
  assert.equal(replay.status, "success");
  if (replay.status !== "success") return;
  assert.equal(replay.output.note_created, false);
  assert.equal(replay.output.card_projection, "unchanged");
  assert.equal(readFileSync(notePath, "utf-8"), humanText);

  assert.equal(first.output.review_status, "pending");
  assert.deepEqual(knowledgePayloads, []);
  assert.deepEqual(reviewPayloads, []);
  const reported = JSON.stringify(replay.output);
  assert.doesNotMatch(reported, /这是我本人|Machine summary|absolute_path/);
});

test("explicit completion registers metadata and projects reviewed state", async () => {
  const { resource, source, artifactRef } = fixture();
  const posts: unknown[] = [];
  const client: Pick<AtlasClient, "controlGet" | "controlPost" | "controlPatch"> = {
    async controlGet<T>() {
      return { ok: true as const, data: { resource, source, artifact: artifactRef } as T };
    },
    async controlPost<T>(path: string, body: unknown) {
      assert.equal(path, "/api/review-actions/complete-comment");
      posts.push(body);
      return {
        ok: true as const,
        data: {
          resource: { ...resource, review_status: "reviewed" },
          knowledge_ref: {
            knowledge_ref_id: "kref_comment",
            note_id: `Knowledge/Comments/${resource.resource_id}`,
            uri: "obsidian://open?vault=Vortex&file=Knowledge%2FComments%2Fres",
            source_ids: [source.source_id],
            resource_ids: [resource.resource_id],
          },
        } as T,
      };
    },
    async controlPatch<T>() {
      return { ok: false as const, status: 500, error: "unused" };
    },
  };

  const result = await completeResourceComment(client, resource.resource_id);
  assert.equal(result.resource.review_status, "reviewed");
  assert.deepEqual(posts, [{ resource_id: resource.resource_id }]);
});

test("vortex-comment-v1 rejects invalid input without touching Atlas", async () => {
  let calls = 0;
  const client: Pick<AtlasClient, "controlGet" | "controlPost" | "controlPatch"> = {
    async controlGet<T>() {
      calls += 1;
      return { ok: false as const, status: 500, error: "unused" };
    },
    async controlPost<T>() {
      calls += 1;
      return { ok: false as const, status: 500, error: "unused" };
    },
    async controlPatch<T>() {
      calls += 1;
      return { ok: false as const, status: 500, error: "unused" };
    },
  };

  const result = await vortexCommentHandler(
    run(undefined),
    new AbortController().signal,
    client,
  );

  assert.deepEqual(result, {
    status: "failure",
    code: "invalid_input",
    message: "Missing required field: resource_id",
    retryable: false,
  });
  assert.equal(calls, 0);
});

test("vortex-comment-v1 classifies missing Resource as non-retryable", async () => {
  const client: Pick<AtlasClient, "controlGet" | "controlPost" | "controlPatch"> = {
    async controlGet<T>() {
      return { ok: false as const, status: 404, error: "HTTP 404" };
    },
    async controlPost<T>() {
      return { ok: false as const, status: 500, error: "unused" };
    },
    async controlPatch<T>() {
      return { ok: false as const, status: 500, error: "unused" };
    },
  };
  const resourceId = `res_${"d".repeat(32)}`;
  const result = await vortexCommentHandler(
    run(resourceId),
    new AbortController().signal,
    client,
  );

  assert.equal(result.status, "failure");
  if (result.status !== "failure") return;
  assert.equal(result.code, "resource_not_found");
  assert.equal(result.retryable, false);
});
