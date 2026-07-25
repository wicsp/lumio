import assert from "node:assert/strict";
import test from "node:test";

import type { AtlasClient } from "../extensions/atlas/client";
import { parseArxivId, requestPaperPreview } from "../extensions/atlas/paper-preview";

test("arXiv IDs and canonical abs/pdf URLs normalize to one identity", () => {
  assert.equal(parseArxivId("2607.01234v2"), "2607.01234v2");
  assert.equal(parseArxivId("https://arxiv.org/abs/2607.01234v2"), "2607.01234v2");
  assert.equal(parseArxivId("https://arxiv.org/pdf/2607.01234v2.pdf"), "2607.01234v2");
  assert.equal(parseArxivId("https://arxiv.org/abs/hep-th/9901001"), "hep-th/9901001");
  assert.throws(() => parseArxivId("https://example.com/2607.01234"), /arxiv\.org/);
});

test("paper preview only captures identity and invokes Atlas workflow", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  const client = {
    async controlPost(path: string, body: unknown) {
      posts.push({ path, body });
      if (path === "/api/sources") {
        return { ok: true as const, data: { source_id: "src_paper_12345678" } };
      }
      return {
        ok: true as const,
        data: {
          invocation_id: "wfi_paper_1",
          step_runs: { acquire: "run_acquire", summarize: "run_summarize" },
        },
      };
    },
  } as Pick<AtlasClient, "controlPost">;

  const result = await requestPaperPreview(client, "https://arxiv.org/pdf/2607.01234.pdf");

  assert.equal(result.run_id, "run_summarize");
  assert.deepEqual(posts.map((item) => item.path), [
    "/api/sources",
    "/api/workflow-invocations",
  ]);
  assert.equal(posts[0].body.source_key, "arxiv:2607.01234");
  assert.equal(posts[1].body.workflow_name, "paper.preview");
  assert.equal(posts[1].body.workflow_version, "1");
  assert.deepEqual(Object.keys(posts[1].body.input).sort(), [
    "arxiv_id",
    "canonical_uri",
    "source_id",
  ]);
});
