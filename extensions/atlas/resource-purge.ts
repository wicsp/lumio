import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { configuredVaultPath, removeResourceCard } from "./obsidian";
import type { HandlerResult, RunRecord } from "./work";

interface PurgeArtifactManifest {
  artifact_id: string;
  uri: string;
  checksum: string | null;
  size_bytes: number | null;
}

interface PurgeResourceManifest {
  resource_id: string;
  kind: "transcript" | "summary" | "extraction" | "comparison";
  artifact: PurgeArtifactManifest | null;
}

interface PurgeInput {
  source_id: string;
  resources: PurgeResourceManifest[];
}

class ResourcePurgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ResourcePurgeError";
  }
}

const SOURCE_ID = /^src_[A-Za-z0-9._-]{8,120}$/;
const RESOURCE_ID = /^res_[A-Za-z0-9._-]{8,120}$/;
const ARTIFACT_ID = /^art_[A-Za-z0-9._-]{8,120}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const RESOURCE_KINDS = new Set(["transcript", "summary", "extraction", "comparison"]);

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ResourcePurgeError("cancelled", "Resource purge was cancelled", false);
  }
}

function parseInput(run: RunRecord): PurgeInput {
  const input = run.input as Partial<PurgeInput>;
  if (typeof input.source_id !== "string" || !SOURCE_ID.test(input.source_id)) {
    throw new ResourcePurgeError("invalid_input", "Invalid or missing source_id", false);
  }
  if (!Array.isArray(input.resources) || input.resources.length === 0 || input.resources.length > 100) {
    throw new ResourcePurgeError("invalid_input", "Resource purge manifest must contain 1-100 items", false);
  }
  for (const item of input.resources) {
    if (!item || typeof item !== "object" || !RESOURCE_ID.test(item.resource_id)) {
      throw new ResourcePurgeError("invalid_input", "Invalid Resource purge manifest", false);
    }
    if (!RESOURCE_KINDS.has(item.kind)) {
      throw new ResourcePurgeError("invalid_input", "Unsupported Resource kind in purge manifest", false);
    }
    if (item.artifact !== null) {
      const artifact = item.artifact;
      if (
        !artifact
        || !ARTIFACT_ID.test(artifact.artifact_id)
        || typeof artifact.uri !== "string"
        || !artifact.uri.startsWith("file://")
        || typeof artifact.checksum !== "string"
        || !CHECKSUM.test(artifact.checksum)
        || (artifact.size_bytes !== null
          && (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0))
      ) {
        throw new ResourcePurgeError("invalid_input", "Invalid Artifact purge manifest", false);
      }
    }
  }
  return input as PurgeInput;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

async function removeArtifact(
  artifact: PurgeArtifactManifest,
  artifactRoot: string,
): Promise<"removed" | "absent"> {
  const lexicalPath = resolve(fileURLToPath(artifact.uri));
  const lexicalRoot = resolve(artifactRoot);
  if (!isWithin(lexicalRoot, lexicalPath)) {
    throw new ResourcePurgeError(
      "artifact_outside_root",
      `Artifact ${artifact.artifact_id} is outside ATLAS_ARTIFACT_ROOT`,
      false,
    );
  }
  if (!existsSync(lexicalPath)) return "absent";

  const resolvedRoot = await realpath(lexicalRoot);
  const info = await lstat(lexicalPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ResourcePurgeError(
      "unsafe_artifact_type",
      `Artifact ${artifact.artifact_id} is not a regular file`,
      false,
    );
  }
  const resolvedPath = await realpath(lexicalPath);
  if (!isWithin(resolvedRoot, resolvedPath)) {
    throw new ResourcePurgeError(
      "artifact_outside_root",
      `Artifact ${artifact.artifact_id} resolves outside ATLAS_ARTIFACT_ROOT`,
      false,
    );
  }
  if (artifact.size_bytes !== null && (await stat(resolvedPath)).size !== artifact.size_bytes) {
    throw new ResourcePurgeError(
      "artifact_size_mismatch",
      `Artifact ${artifact.artifact_id} size does not match the deletion manifest`,
      false,
    );
  }
  if (await sha256File(resolvedPath) !== artifact.checksum) {
    throw new ResourcePurgeError(
      "artifact_hash_mismatch",
      `Artifact ${artifact.artifact_id} checksum does not match the deletion manifest`,
      false,
    );
  }
  await unlink(resolvedPath);
  try {
    await rmdir(dirname(resolvedPath));
  } catch {
    // The per-source directory may still contain another Resource version.
  }
  return "removed";
}

export async function vortexResourcePurgeHandler(
  run: RunRecord,
  signal: AbortSignal,
): Promise<HandlerResult> {
  try {
    const input = parseInput(run);
    const artifacts = input.resources.filter((item) => item.artifact !== null);
    const summaries = input.resources.filter((item) => item.kind === "summary");
    const artifactRoot = process.env.ATLAS_ARTIFACT_ROOT?.trim();
    if (artifacts.length > 0 && !artifactRoot) {
      throw new ResourcePurgeError(
        "artifact_root_unconfigured",
        "ATLAS_ARTIFACT_ROOT is required for Resource byte cleanup",
        false,
      );
    }
    const vaultPath = configuredVaultPath();
    if (summaries.length > 0 && !vaultPath) {
      throw new ResourcePurgeError(
        "vault_unconfigured",
        "ATLAS_OBSIDIAN_VAULT is required for Resource Card cleanup",
        false,
      );
    }

    let artifactsRemoved = 0;
    let artifactsAbsent = 0;
    let cardsRemoved = 0;
    let cardsAbsent = 0;
    for (const item of input.resources) {
      checkAbort(signal);
      if (item.artifact && artifactRoot) {
        const action = await removeArtifact(item.artifact, artifactRoot);
        if (action === "removed") artifactsRemoved += 1;
        else artifactsAbsent += 1;
      }
      if (item.kind === "summary" && vaultPath) {
        const card = await removeResourceCard(vaultPath, item.resource_id);
        if (card.removed) cardsRemoved += 1;
        else cardsAbsent += 1;
      }
    }

    return {
      status: "success",
      output: {
        source_id: input.source_id,
        resources_purged: input.resources.length,
        artifacts_removed: artifactsRemoved,
        artifacts_absent: artifactsAbsent,
        cards_removed: cardsRemoved,
        cards_absent: cardsAbsent,
      },
      artifacts: [],
      source_updates: [],
      resources: [],
    };
  } catch (error) {
    if (error instanceof ResourcePurgeError) {
      return {
        status: "failure",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }
    return {
      status: "failure",
      code: "resource_cleanup_failed",
      message: "Unexpected failure while deleting local Resource material",
      retryable: true,
    };
  }
}
