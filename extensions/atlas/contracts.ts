export interface ArtifactRefCreate {
  name: string;
  uri: string;
  content_type?: string;
  size_bytes?: number;
  checksum?: string;
}

export interface ArtifactRef {
  artifact_id: string;
  run_id: string;
  name: string;
  uri: string;
  content_type: string | null;
  size_bytes: number | null;
  checksum: string | null;
  created_at: string;
}

export interface ResourceCreate {
  resource_id: string;
  source_id: string;
  kind: "transcript" | "summary" | "extraction" | "comparison";
  title: string;
  artifact_name: string;
  content_hash: string;
  generator: {
    mode: "deterministic" | "ai";
    name: string;
    version: string;
    model_provider?: string;
    model_id?: string;
    prompt_version?: string;
  };
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  run_id: string;
  project_id: string;
  job_name: string;
  capabilities_required: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: "blocked" | "pending" | "claimed" | "completed" | "failed" | "cancelled";
  agent_id: string | null;
  lease_expires_at: string | null;
  attempt_number: number;
  max_attempts: number;
  priority: number;
  metadata: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}
