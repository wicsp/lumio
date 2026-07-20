import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";

import type {
  ArtifactRefCreate,
  HandlerResult,
  ResourceGenerator,
  RunRecord,
} from "../work";
import {
  artifactRoot,
  createResourceId,
  requiredChecksum,
  storeTextArtifact,
} from "../artifacts";

const MAX_EXTRACTION_BYTES = 2 * 1024 * 1024;

export interface WebRunInput {
  source_id: string;
  url: string;
  title: string;
  captured_at: string;
  extraction: ArtifactRefCreate;
}

export interface WebSummaryRequest {
  url: string;
  title: string;
  markdown: string;
}

export interface WebSummaryResult {
  markdown: string;
  generator: ResourceGenerator;
  metadata: Record<string, unknown>;
}

export type WebSummaryGenerator = (
  request: WebSummaryRequest,
  signal: AbortSignal,
) => Promise<WebSummaryResult>;

function readVerifiedExtraction(artifact: ArtifactRefCreate): string {
  if (!artifact.uri.startsWith("file://")) throw new Error("Extraction Artifact must use file://");
  const root = realpathSync(artifactRoot());
  const path = realpathSync(fileURLToPath(artifact.uri));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error("Extraction Artifact is outside ATLAS_ARTIFACT_ROOT");
  }
  const size = statSync(path).size;
  if (size > MAX_EXTRACTION_BYTES) throw new Error("Extraction Artifact exceeds 2 MiB");
  const content = readFileSync(path, "utf-8");
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (checksum !== requiredChecksum(artifact)) throw new Error("Extraction Artifact checksum mismatch");
  return content;
}

export function storeWebSummaryArtifact(markdown: string, sourceId: string): ArtifactRefCreate {
  return storeTextArtifact(
    markdown,
    "resources/web",
    sourceId,
    `summary-${sourceId}`,
    ".md",
    "text/markdown; charset=utf-8",
  );
}

export async function webSummaryHandler(
  run: RunRecord,
  signal: AbortSignal,
  summarize?: WebSummaryGenerator,
): Promise<HandlerResult> {
  const input = run.input as unknown as WebRunInput;
  const sourceId = input?.source_id?.trim();
  const title = input?.title?.trim();
  let url: URL;
  try {
    url = new URL(input?.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return { status: "failure", code: "invalid_input", message: "Invalid web capture URL", retryable: false };
  }
  if (!sourceId || !title || !input?.extraction) {
    return { status: "failure", code: "invalid_input", message: "Missing web capture fields", retryable: false };
  }
  if (!summarize) {
    return {
      status: "failure",
      code: "summary_model_unavailable",
      message: "No Pi summary model is available for this session.",
      retryable: true,
    };
  }

  let extraction: string;
  try {
    extraction = readVerifiedExtraction(input.extraction).trim();
  } catch (error) {
    return {
      status: "failure",
      code: "extraction_unavailable",
      message: `Cannot read captured page: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    };
  }
  if (!extraction) {
    return { status: "failure", code: "empty_extraction", message: "Captured page is empty", retryable: false };
  }

  let summary: WebSummaryResult;
  try {
    summary = await summarize({ url: url.href, title, markdown: extraction }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: "failure",
      code: "summary_failed",
      message: `AI web summary failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
      retryable: true,
    };
  }
  const summaryMarkdown = summary.markdown.trim();
  if (!summaryMarkdown) {
    return { status: "failure", code: "empty_summary", message: "AI model returned an empty summary", retryable: true };
  }

  const summaryArtifact = storeWebSummaryArtifact(`${summaryMarkdown}\n`, sourceId);
  const extractionHash = requiredChecksum(input.extraction);
  const summaryHash = requiredChecksum(summaryArtifact);
  const extractionResourceId = createResourceId(sourceId, "extraction", extractionHash);

  return {
    status: "success",
    output: {
      url: url.href,
      title: title.slice(0, 1000),
      captured_at: input.captured_at,
      extraction_bytes: input.extraction.size_bytes ?? Buffer.byteLength(extraction),
      processing_level: 2,
    },
    artifacts: [input.extraction, summaryArtifact],
    source_updates: [{
      source_id: sourceId,
      canonical_uri: url.href,
      title: title.slice(0, 1000),
      metadata: { captured_at: input.captured_at, captured_via: "lumio-web-clipper" },
    }],
    resources: [
      {
        resource_id: extractionResourceId,
        source_id: sourceId,
        kind: "extraction",
        title: `${title.slice(0, 1000)} — extraction`,
        artifact_name: input.extraction.name,
        content_hash: extractionHash,
        generator: { mode: "deterministic", name: "lumio-web-clipper", version: "1" },
        metadata: { profile_id: "web-extraction-v1", captured_at: input.captured_at },
      },
      {
        resource_id: createResourceId(sourceId, "summary", summaryHash),
        source_id: sourceId,
        kind: "summary",
        title: `${title.slice(0, 1000)} — AI summary`,
        artifact_name: summaryArtifact.name,
        content_hash: summaryHash,
        generator: summary.generator,
        metadata: {
          profile_id: "web-overview-v1",
          ...summary.metadata,
          extraction_resource_id: extractionResourceId,
        },
      },
    ],
  };
}
