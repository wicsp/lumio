import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { generateDailyReviewDigest, generateWeeklyAudit } from "../extensions/atlas/digests";
import { createKnowledgeCommentDraft, type AtlasResourceRecord } from "../extensions/atlas/obsidian";

const resource: AtlasResourceRecord = {
  resource_id: `res_${"a".repeat(32)}`,
  source_id: `src_${"b".repeat(32)}`,
  produced_by_run_id: `run_${"c".repeat(32)}`,
  artifact_id: `art_${"d".repeat(32)}`,
  kind: "summary",
  title: "Digest resource",
  content_hash: `sha256:${"e".repeat(64)}`,
  generator: {
    mode: "ai",
    name: "lumio-test",
    version: "1",
    model_provider: "openai",
    model_id: "test",
    prompt_version: "test-v1",
  },
  metadata: { profile_id: "overview-v1" },
  review_status: "pending",
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
};

function client(
  knowledgeRefs: unknown[] = [],
  resources: AtlasResourceRecord[] = [resource],
): Pick<AtlasClient, "controlGet"> {
  return {
    async controlGet<T>(path: string) {
      if (path === "/api/sources?limit=500") return { ok: true as const, data: [{
        source_id: resource.source_id,
        source_key: "test:one",
        kind: "other",
        canonical_uri: "https://example.test/one",
        title: "Digest source",
        external_ids: {},
        metadata: {},
        created_at: resource.created_at,
        updated_at: resource.updated_at,
      }] as T };
      if (path === "/api/resources?kind=summary&limit=500") {
        return { ok: true as const, data: resources as T };
      }
      if (path === "/api/knowledge-refs?limit=500") {
        return { ok: true as const, data: knowledgeRefs as T };
      }
      if (path === "/api/runs?limit=500") return { ok: true as const, data: [] as T };
      return { ok: false as const, status: 404, error: path };
    },
  };
}

test("daily digest is deterministic and lists pending work and local drafts", async () => {
  const vault = mkdtempSync(join(tmpdir(), "lumio-digest-"));
  await createKnowledgeCommentDraft(vault, resource);
  const first = await generateDailyReviewDigest(client(), vault, "2026-07-20");
  const second = await generateDailyReviewDigest(client(), vault, "2026-07-20");
  const content = readFileSync(join(vault, first.relative_path), "utf-8");

  assert.equal(first.action, "created");
  assert.equal(second.action, "unchanged");
  assert.match(content, /当前待判断：1/);
  assert.match(content, /本地未完成草稿：1/);
  assert.match(content, /Digest source/);
});

test("weekly audit reports a reviewed Resource without KnowledgeRef", async () => {
  const vault = mkdtempSync(join(tmpdir(), "lumio-audit-"));
  const result = await generateWeeklyAudit(
    client([], [{ ...resource, review_status: "reviewed" }]),
    vault,
    "2026-07-20",
  );
  const content = readFileSync(join(vault, result.relative_path), "utf-8");
  assert.match(content, /已 reviewed，但没有 KnowledgeRef/);
});
