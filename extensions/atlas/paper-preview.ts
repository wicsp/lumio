import type { AtlasClient } from "./client";
import type { AtlasSourceRecord } from "./obsidian";

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[A-Za-z.-]+\/\d{7})(?:v\d+)?$/;

export interface PaperPreviewResult {
  arxiv_id: string;
  source_id: string;
  invocation_id: string;
  run_id: string;
}

export function parseArxivId(value: string): string {
  const input = value.trim();
  if (ARXIV_ID.test(input)) return input.toLowerCase();

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Expected an arXiv ID or arxiv.org abs/pdf URL");
  }
  if (url.protocol !== "https:" || !["arxiv.org", "www.arxiv.org"].includes(url.hostname)) {
    throw new Error("Expected an HTTPS arxiv.org abs/pdf URL");
  }
  const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
  const id = match?.[1] ?? "";
  if (!ARXIV_ID.test(id)) throw new Error("URL does not contain a valid arXiv ID");
  return id.toLowerCase();
}

export async function requestPaperPreview(
  client: Pick<AtlasClient, "controlPost">,
  input: string,
): Promise<PaperPreviewResult> {
  const arxivId = parseArxivId(input);
  const canonicalUri = `https://arxiv.org/abs/${arxivId}`;
  const source = await client.controlPost<AtlasSourceRecord>("/api/sources", {
    source_key: `arxiv:${arxivId}`,
    kind: "paper",
    canonical_uri: canonicalUri,
    title: null,
    external_ids: { arxiv_id: arxivId },
    metadata: { captured_via: "lumio-paper-preview" },
  });
  if (!source.ok) throw new Error(`Atlas Source capture failed: ${source.error}`);

  const invocation = await client.controlPost<{
    invocation_id: string;
    step_runs: Record<string, string>;
  }>("/api/workflow-invocations", {
    workflow_name: "paper.preview",
    workflow_version: "1",
    input: {
      source_id: source.data.source_id,
      arxiv_id: arxivId,
      canonical_uri: canonicalUri,
    },
  });
  if (!invocation.ok) throw new Error(`Atlas paper preview enqueue failed: ${invocation.error}`);
  const runId = invocation.data.step_runs.summarize;
  if (!runId) throw new Error("Atlas paper preview workflow omitted summarize step");
  return {
    arxiv_id: arxivId,
    source_id: source.data.source_id,
    invocation_id: invocation.data.invocation_id,
    run_id: runId,
  };
}
