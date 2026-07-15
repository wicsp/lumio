import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResourceId,
  storeSummaryArtifact,
} from "../extensions/atlas/jobs/bilibili";
import {
  createKnowledgeCommentDraft,
  ensureVaultStructure,
  projectResourceCard,
  type AtlasResourceRecord,
} from "../extensions/atlas/obsidian";

function resource(overrides: Partial<AtlasResourceRecord> = {}): AtlasResourceRecord {
  return {
    resource_id: `res_${"b".repeat(32)}`,
    source_id: "src_example",
    produced_by_run_id: "run_example",
    artifact_id: "art_example",
    kind: "summary",
    title: "A generated summary",
    content_hash: `sha256:${"b".repeat(64)}`,
    generator: {
      mode: "ai",
      name: "lumio-bilibili-summary",
      version: "1",
      model_provider: "openai",
      model_id: "gpt-test",
      prompt_version: "bilibili-summary-v1",
    },
    metadata: {},
    review_status: "pending",
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

test("summary artifacts and Resource IDs are content addressed", () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc3-artifacts-"));
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const first = storeSummaryArtifact("# Summary\n", "BV1234567890");
  const second = storeSummaryArtifact("# Summary\n", "BV1234567890");

  assert.equal(first.uri, second.uri);
  assert.equal(first.checksum, second.checksum);
  assert.match(first.checksum ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(statSync(first.uri.replace(/^file:\/\//, "")).mode & 0o777, 0o600);
  assert.equal(
    createResourceId("src_one", "summary", first.checksum!),
    createResourceId("src_one", "summary", second.checksum!),
  );
  assert.notEqual(
    createResourceId("src_one", "transcript", first.checksum!),
    createResourceId("src_one", "summary", first.checksum!),
  );
});

test("Resource Card is rebuilt from verified artifact and marked machine generated", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc3-project-"));
  const artifactRoot = join(root, "artifacts");
  const vault = join(root, "Vortex Next");
  process.env.ATLAS_ARTIFACT_ROOT = artifactRoot;
  const artifact = storeSummaryArtifact("# 内容概览\n\n机器摘要。\n", "BV1234567890");
  const cardResource = resource({ content_hash: artifact.checksum! });

  const relativePath = await projectResourceCard(vault, {
    ...cardResource,
    artifact_uri: artifact.uri,
    source_uri: "https://www.bilibili.com/video/BV1234567890",
  });
  const card = readFileSync(join(vault, relativePath), "utf-8");

  assert.equal(relativePath, `Resources/Cards/${cardResource.resource_id}.md`);
  assert.match(card, /generated: true/);
  assert.match(card, /Machine-generated Resource/);
  assert.match(card, /机器摘要/);
  assert.match(card, new RegExp(cardResource.resource_id));
  assert.match(card, new RegExp(cardResource.source_id));
  assert.match(card, /https:\/\/www\.bilibili\.com\/video\/BV1234567890/);
});

test("Resource Card projection rejects artifact hash mismatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc3-mismatch-"));
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const artifactPath = join(root, "summary.md");
  writeFileSync(artifactPath, "changed bytes", "utf-8");

  await assert.rejects(
    projectResourceCard(join(root, "vault"), {
      ...resource(),
      artifact_uri: `file://${artifactPath}`,
      source_uri: "https://example.test/source",
    }),
    /checksum mismatch/,
  );
});

test("blank Knowledge Comment is explicit and never overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc3-comment-"));
  const vault = join(root, "Vortex Next");
  await ensureVaultStructure(vault);
  const first = await createKnowledgeCommentDraft(vault, resource());
  const initial = readFileSync(first.absolute_path, "utf-8");

  assert.equal(first.created, true);
  assert.match(initial, /## 我的评论/);
  assert.doesNotMatch(initial, /机器摘要/);

  const humanText = `${initial}\n这是我本人写下并负责的评论。\n`;
  writeFileSync(first.absolute_path, humanText, "utf-8");
  const second = await createKnowledgeCommentDraft(vault, resource());

  assert.equal(second.created, false);
  assert.equal(readFileSync(first.absolute_path, "utf-8"), humanText);
  assert.match(second.note_id, /^Knowledge\/Comments\//);
  assert.match(second.uri, /^obsidian:\/\/open\?/);
});

test("new vault structure separates Knowledge and Resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-rfc3-vault-"));
  const vault = join(root, "Vortex Next");
  await ensureVaultStructure(vault);

  const policy = readFileSync(join(vault, "System", "Policy.md"), "utf-8");
  assert.match(policy, /Knowledge\/\*\*/);
  assert.match(policy, /Resources\/\*\*/);
  assert.match(policy, /never generate, complete, rewrite/);
  assert.ok(statSync(join(vault, "Knowledge", "Comments")).isDirectory());
  assert.ok(statSync(join(vault, "Resources", "Cards")).isDirectory());
  assert.ok(statSync(join(vault, "Resources", "Digests", "Daily Papers")).isDirectory());
});
