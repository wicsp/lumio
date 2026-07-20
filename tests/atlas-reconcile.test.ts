import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import {
  ATLAS_WORK_POLL_INTERVAL_MS,
  reconcileResourceCards,
} from "../extensions/atlas/index";
import { storeSummaryArtifact } from "../extensions/atlas/jobs/bilibili";
import type {
  AtlasResourceRecord,
  AtlasSourceRecord,
} from "../extensions/atlas/obsidian";
import type { ArtifactRef } from "../extensions/atlas/work";

test("interactive Atlas work polling stays responsive", () => {
  assert.equal(ATLAS_WORK_POLL_INTERVAL_MS, 2_000);
});

function summaryResource(
  resourceId: string,
  contentHash: string,
  reviewStatus: AtlasResourceRecord["review_status"],
): AtlasResourceRecord {
  return {
    resource_id: resourceId,
    source_id: "src_reconcile",
    produced_by_run_id: "run_reconcile",
    artifact_id: "art_reconcile",
    kind: "summary",
    title: "Reconciliation summary",
    content_hash: contentHash,
    generator: {
      mode: "ai",
      name: "lumio-test",
      version: "1",
      model_provider: "openai",
      model_id: "gpt-test",
      prompt_version: "test-v1",
    },
    metadata: {},
    review_status: reviewStatus,
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

test("reconciliation projects active summaries, removes dismissed cards, and becomes a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-reconcile-"));
  const artifactRoot = join(root, "artifacts");
  const vault = join(root, "Vortex");
  process.env.ATLAS_ARTIFACT_ROOT = artifactRoot;
  process.env.ATLAS_OBSIDIAN_VAULT = vault;

  const artifact = storeSummaryArtifact("# Reconciled Resource\n", "BV1234567890");
  const active = summaryResource(`res_${"a".repeat(32)}`, artifact.checksum!, "reviewed");
  const dismissed = summaryResource(`res_${"d".repeat(32)}`, artifact.checksum!, "dismissed");
  const dismissedCard = join(vault, "Resources", "Cards", `${dismissed.resource_id}.md`);
  mkdirSync(join(vault, "Resources", "Cards"), { recursive: true });
  writeFileSync(dismissedCard, "stale generated card", "utf-8");

  const source: AtlasSourceRecord = {
    source_id: active.source_id,
    source_key: "bilibili:BV1234567890",
    kind: "video",
    canonical_uri: "https://www.bilibili.com/video/BV1234567890",
    title: "Reconciliation source",
    external_ids: { bvid: "BV1234567890" },
    metadata: {},
    created_at: active.created_at,
    updated_at: active.updated_at,
  };
  const artifactRef: ArtifactRef = {
    artifact_id: active.artifact_id,
    run_id: active.produced_by_run_id,
    name: "summary",
    uri: artifact.uri,
    content_type: "text/markdown; charset=utf-8",
    size_bytes: artifact.size_bytes,
    checksum: artifact.checksum ?? null,
    created_at: active.created_at,
  };
  const fakeClient: Pick<AtlasClient, "controlGet"> = {
    async controlGet<T>(path: string) {
      if (path === "/api/resources?kind=summary&limit=500") {
        return { ok: true as const, data: [active, dismissed] as T };
      }
      if (path === "/api/resources?kind=comparison&limit=500") {
        return { ok: true as const, data: [] as T };
      }
      if (path === "/api/knowledge-refs?limit=500") {
        return { ok: true as const, data: [] as T };
      }
      if (path === `/api/resources/${active.resource_id}/bundle`) {
        return {
          ok: true as const,
          data: { resource: active, source, artifact: artifactRef } as T,
        };
      }
      return { ok: false as const, status: 404, error: `Unexpected path: ${path}` };
    },
  };

  const first = await reconcileResourceCards(fakeClient);
  assert.deepEqual(first, {
    created: 1,
    updated: 0,
    removed: 1,
    unchanged: 0,
    failed: 0,
    errors: [],
  });
  const activeCard = join(vault, "Resources", "Cards", `${active.resource_id}.md`);
  assert.match(readFileSync(activeCard, "utf-8"), /review_status: "reviewed"/);

  const second = await reconcileResourceCards(fakeClient);
  assert.deepEqual(second, {
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 2,
    failed: 0,
    errors: [],
  });
});
