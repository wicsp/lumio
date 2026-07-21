import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import {
  createComparisonHandler,
  parseComparisonDocument,
  relevantComments,
  renderComparisonMarkdown,
} from "../extensions/atlas/comparison";
import { storeSummaryArtifact } from "../extensions/atlas/artifacts";
import type { AtlasResourceRecord, AtlasSourceRecord } from "../extensions/atlas/obsidian";
import type { PiSummaryRuntime } from "../extensions/atlas/summarize";
import type { ArtifactRef, RunRecord } from "../extensions/atlas/work";
import type { AtlasCommentRecord } from "../extensions/atlas/resource-review";

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

test("comparison selects only comments for the Resource or its Source", () => {
  const exact: AtlasCommentRecord = {
    comment_id: "cmt_exact",
    knowledge_ref_id: "kref_exact",
    note_id: "Knowledge/Comments/res_exact",
    source_ids: ["src_same"],
    resource_ids: ["res_exact"],
    body_markdown: "## 我的评论\n\nexact",
    content_hash: `sha256:${"a".repeat(64)}`,
    format: "text/markdown",
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
  };
  const sameSource: AtlasCommentRecord = {
    ...exact,
    comment_id: "cmt_source",
    knowledge_ref_id: "kref_source",
    note_id: "Knowledge/Comments/res_old",
    source_ids: ["src_same"],
    resource_ids: ["res_old"],
  };
  const unrelated: AtlasCommentRecord = {
    ...exact,
    comment_id: "cmt_unrelated",
    knowledge_ref_id: "kref_unrelated",
    note_id: "Knowledge/Comments/res_other",
    source_ids: ["src_other"],
    resource_ids: ["res_other"],
  };
  assert.deepEqual(
    relevantComments([unrelated, sameSource, exact], "res_exact", "src_same"),
    [exact, sameSource],
  );
});

test("comparison renders readable Obsidian cards without internal KnowledgeRef IDs", () => {
  const document = parseComparisonDocument(`\`\`\`json
{"overview":"双方对核心功能基本一致，但评价仍有差异。","items":[{"relation":"supports","topic":"工作区模型","source_view":"来源认为工作区位于标签与分屏之上。","my_view":"我认为它用工作区替代了 session。","assessment":"两者描述的是同一个组织层级变化。","comment_index":1},{"relation":"contradicts","topic":"整体易用性","source_view":"来源认为它优于 Tmux。","my_view":"我认为它可能不如 Cmux。","assessment":"评价不同，但比较对象也不同。","comment_index":1}],"open_questions":["需要在同一任务上实测。"]}
\`\`\``);
  const markdown = renderComparisonMarkdown(document, "res_summary", [{
    label: "我的评论 1",
    comment: {
      comment_id: "cmt_secret",
      knowledge_ref_id: "kref_secret",
      note_id: "Knowledge/Comments/res_summary",
      source_ids: ["src_same"],
      resource_ids: ["res_summary"],
      body_markdown: "## 我的评论\n\n我的观点",
      content_hash: `sha256:${"a".repeat(64)}`,
      format: "text/markdown",
      created_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:00Z",
    },
  }]);

  assert.match(markdown, /\[!summary\] 一眼结论/);
  assert.match(markdown, /共识 1/);
  assert.match(markdown, /分歧 1/);
  assert.match(markdown, /\[!success\].*工作区模型/);
  assert.match(markdown, /\*\*来源观点\*\*/);
  assert.match(markdown, /\*\*我的观点\*\*/);
  assert.match(markdown, /\[\[Knowledge\/Comments\/res_summary\|我的评论 1\]\]/);
  assert.doesNotMatch(markdown, /kref_/);
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
      if (path === `/api/comments?source_id=${encodeURIComponent(resource.source_id)}&limit=500`) {
        return { ok: true as const, data: [] as T };
      }
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
