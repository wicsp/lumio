import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ArtifactRefCreate, ResourceCreate } from "./work";

export function artifactRoot(): string {
  const root = process.env.ATLAS_ARTIFACT_ROOT?.trim();
  if (!root) throw new Error("ATLAS_ARTIFACT_ROOT must be configured for content storage");
  return root;
}

/** Write immutable, content-addressed text without exposing partial files. */
export function storeTextArtifact(
  content: string,
  directory: string,
  identity: string,
  name: string,
  extension: ".txt" | ".md",
  contentType: string,
): ArtifactRefCreate {
  const hash = createHash("sha256").update(content).digest("hex");
  const dir = join(artifactRoot(), directory, identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const destPath = join(dir, `${hash.slice(0, 16)}${extension}`);
  if (!existsSync(destPath)) {
    const tempPath = join(dir, `.${hash.slice(0, 16)}.${randomUUID()}${extension}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tempPath, "wx", 0o600);
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, destPath);
    } finally {
      if (fd !== null) closeSync(fd);
      try { unlinkSync(tempPath); } catch { /* already renamed or absent */ }
    }
  } else {
    const existingHash = createHash("sha256").update(readFileSync(destPath)).digest("hex");
    if (existingHash !== hash) throw new Error(`Artifact hash collision at ${destPath}`);
  }

  return {
    name,
    uri: `file://${destPath}`,
    content_type: contentType,
    size_bytes: Buffer.byteLength(content, "utf-8"),
    checksum: `sha256:${hash}`,
  };
}

export function requiredChecksum(artifact: ArtifactRefCreate): string {
  if (!artifact.checksum?.match(/^sha256:[0-9a-f]{64}$/)) {
    throw new Error(`Artifact ${artifact.name} is missing a SHA-256 checksum`);
  }
  return artifact.checksum;
}

export function createResourceId(
  sourceId: string,
  kind: ResourceCreate["kind"],
  contentHash: string,
): string {
  const digest = createHash("sha256")
    .update(`${sourceId}\0${kind}\0${contentHash}`)
    .digest("hex");
  return `res_${digest.slice(0, 32)}`;
}

export function storeTranscriptArtifact(path: string, bvid: string): ArtifactRefCreate {
  return storeTextArtifact(
    readFileSync(path, "utf-8"),
    "transcripts",
    bvid,
    `transcript-${bvid}`,
    ".txt",
    "text/plain; charset=utf-8",
  );
}

export function storeSummaryArtifact(markdown: string, identity: string): ArtifactRefCreate {
  return storeTextArtifact(
    markdown,
    join("resources", "bilibili"),
    identity,
    `summary-${identity}`,
    ".md",
    "text/markdown; charset=utf-8",
  );
}

export function storeComparisonArtifact(markdown: string, sourceId: string): ArtifactRefCreate {
  return storeTextArtifact(
    markdown,
    join("resources", "comparisons"),
    sourceId,
    `comparison-${sourceId}`,
    ".md",
    "text/markdown; charset=utf-8",
  );
}
