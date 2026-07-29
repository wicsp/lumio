import type { AtlasClient } from "./client";
import type { AtlasSourceRecord } from "./obsidian";

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[A-Za-z.-]+\/\d{7})(?:v\d+)?$/;

export interface PaperPreviewResult {
  arxiv_id: string;
  source_id: string;
  invocation_id: string;
  run_id: string;
  preview_resource_id: string;
  reused: boolean;
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

  const ingest = await client.controlPost<{
    reused: boolean;
    invocation?: {
      invocation_id: string;
      step_runs: Record<string, string>;
    } | null;
    preview_resource?: { resource_id: string } | null;
  }>("/api/paper/ingest", {
    source_id: source.data.source_id,
  });
  if (!ingest.ok) throw new Error(`Atlas paper ingest enqueue failed: ${ingest.error}`);
  const runId = ingest.data.invocation?.step_runs.summarize ?? "";
  const previewResourceId = ingest.data.preview_resource?.resource_id ?? "";
  if (!runId && !previewResourceId) {
    throw new Error("Atlas paper ingest response omitted its workflow or preview");
  }
  return {
    arxiv_id: arxivId,
    source_id: source.data.source_id,
    invocation_id: ingest.data.invocation?.invocation_id ?? "",
    run_id: runId,
    preview_resource_id: previewResourceId,
    reused: ingest.data.reused,
  };
}
