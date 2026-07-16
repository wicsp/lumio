import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireBilibiliTranscript,
  bilibiliSummaryHandler,
  runLocalAsr,
  type AcquiredTranscript,
  type BilibiliAcquisitionRequest,
  type BilibiliVideoInfo,
} from "../extensions/atlas/jobs/bilibili";
import type { RunRecord } from "../extensions/atlas/work";

const request: BilibiliAcquisitionRequest = {
  bvid: "BV1NG9xBUEju",
  url: "https://www.bilibili.com/video/BV1NG9xBUEju",
  canonicalUrl: "https://www.bilibili.com/video/BV1NG9xBUEju",
  browser: "dia",
  language: "ai-zh",
};

const info: BilibiliVideoInfo = {
  title: "Test video",
  description: "Description",
  duration_seconds: 1225,
  duration_text: "20:25",
  cover_url: "https://example.test/cover.jpg",
  page_count: 1,
};

function localTranscript(text = "这是由本地语音识别得到的测试转写。"): AcquiredTranscript {
  return {
    text,
    mode: "local_asr",
    language: "zh",
    generator: {
      mode: "ai",
      name: "whisper.cpp",
      version: "1",
      model_provider: "local",
      model_id: "whisper.cpp/small",
      prompt_version: "audio-transcription-v1",
    },
    metadata: {
      acquisition_mode: "local_asr",
      asr_engine: "whisper.cpp",
      asr_model: "small",
      retained_media: false,
    },
  };
}

function runRecord(): RunRecord {
  return {
    run_id: "run_bilibili_v4",
    project_id: "bilibili-capture",
    job_name: "bilibili-summary-v4",
    capabilities_required: ["bilibili-summary-v4"],
    input: {
      url: request.url,
      canonical_url: request.canonicalUrl,
      source_id: "src_bilibili_test",
    },
    output: null,
    status: "claimed",
    agent_id: "agt_test",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    max_attempts: 3,
    priority: 5,
    metadata: {},
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

test("platform subtitles win and anonymous access does not activate ASR", async () => {
  let asrCalled = false;
  const result = await acquireBilibiliTranscript(request, new AbortController().signal, {
    extractCookies: async () => null,
    fetchVideoInfo: async () => info,
    fetchPlatformTranscript: async () => ({
      text: "平台字幕",
      language: "ai-zh",
      metadata: { acquisition_mode: "platform_subtitle", authenticated: false },
    }),
    runLocalAsr: async () => {
      asrCalled = true;
      return { status: "success", info, transcript: localTranscript() };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(asrCalled, false);
  if (result.status === "success") {
    assert.equal(result.transcript.mode, "platform_subtitle");
    assert.equal(result.transcript.generator.mode, "deterministic");
    assert.equal(result.transcript.text, "平台字幕");
  }
});

test("missing platform subtitles activate local ASR and clean temporary cookies", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-bili-cookie-"));
  const cookiePath = join(root, "cookies.txt");
  writeFileSync(cookiePath, "# Netscape HTTP Cookie File\n", { mode: 0o600 });
  let asrCalled = false;

  const result = await acquireBilibiliTranscript(request, new AbortController().signal, {
    extractCookies: async () => cookiePath,
    fetchVideoInfo: async () => info,
    fetchPlatformTranscript: async () => null,
    runLocalAsr: async (_request, receivedInfo, receivedCookie) => {
      asrCalled = true;
      assert.equal(receivedInfo, info);
      assert.equal(receivedCookie, cookiePath);
      return { status: "success", info, transcript: localTranscript() };
    },
  });

  assert.equal(result.status, "success");
  assert.equal(asrCalled, true);
  assert.equal(existsSync(cookiePath), false);
  if (result.status === "success") {
    assert.equal(result.transcript.mode, "local_asr");
  }
});

test("local ASR fails visibly before download when the model is missing", async () => {
  const previous = process.env.BILIBILI_ASR_MODEL;
  process.env.BILIBILI_ASR_MODEL = join(
    mkdtempSync(join(tmpdir(), "lumio-missing-model-")),
    "ggml-small.bin",
  );
  try {
    const result = await runLocalAsr(request, info, null, new AbortController().signal);
    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.code, "asr_not_configured");
      assert.equal(result.retryable, false);
    }
  } finally {
    if (previous === undefined) delete process.env.BILIBILI_ASR_MODEL;
    else process.env.BILIBILI_ASR_MODEL = previous;
  }
});

test("missing ASR binaries are explicit and leave no task media directory", async () => {
  const previousModel = process.env.BILIBILI_ASR_MODEL;
  const previousYtDlp = process.env.BILIBILI_YT_DLP_BIN;
  const modelPath = join(mkdtempSync(join(tmpdir(), "lumio-fake-model-")), "ggml-small.bin");
  writeFileSync(modelPath, "test model placeholder");
  process.env.BILIBILI_ASR_MODEL = modelPath;
  process.env.BILIBILI_YT_DLP_BIN = join(tmpdir(), "lumio-command-that-does-not-exist");
  try {
    const result = await runLocalAsr(request, info, null, new AbortController().signal);
    assert.equal(result.status, "failure");
    if (result.status === "failure") assert.equal(result.code, "asr_not_configured");
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith(`lumio-bili-asr-${request.bvid}-`)),
      [],
    );
  } finally {
    if (previousModel === undefined) delete process.env.BILIBILI_ASR_MODEL;
    else process.env.BILIBILI_ASR_MODEL = previousModel;
    if (previousYtDlp === undefined) delete process.env.BILIBILI_YT_DLP_BIN;
    else process.env.BILIBILI_YT_DLP_BIN = previousYtDlp;
  }
});

test("multi-part videos never produce a partial local-ASR summary", async () => {
  const result = await runLocalAsr(
    request,
    { ...info, page_count: 3 },
    null,
    new AbortController().signal,
  );
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.equal(result.code, "multipart_asr_unsupported");
    assert.equal(result.retryable, false);
  }
});

test("v4 handler publishes bounded ASR provenance without transcript bytes in Run output", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumio-bili-v4-artifacts-"));
  process.env.ATLAS_ARTIFACT_ROOT = root;
  const secretTranscript = "这是只允许存在于 transcript Artifact 中的正文。";

  const result = await bilibiliSummaryHandler(
    runRecord(),
    new AbortController().signal,
    async ({ transcript }) => {
      assert.equal(transcript, secretTranscript);
      return {
        markdown: "# AI Summary\n\n测试摘要。",
        generator: {
          mode: "ai",
          name: "lumio-bilibili-summary",
          version: "1",
          model_provider: "test",
          model_id: "test-model",
          prompt_version: "bilibili-summary-v1",
        },
        metadata: { chunk_count: 1 },
      };
    },
    async () => ({ status: "success", info, transcript: localTranscript(secretTranscript) }),
  );

  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.output.transcript_acquisition_mode, "local_asr");
  assert.equal(result.output.asr_engine, "whisper.cpp");
  assert.equal(result.output.asr_model, "small");
  assert.doesNotMatch(JSON.stringify(result.output), new RegExp(secretTranscript));
  assert.equal(result.resources.length, 2);
  assert.equal(result.resources[0].generator.name, "whisper.cpp");
  assert.deepEqual(
    {
      mode: result.resources[0].generator.mode,
      model_provider: result.resources[0].generator.model_provider,
      model_id: result.resources[0].generator.model_id,
      prompt_version: result.resources[0].generator.prompt_version,
    },
    {
      mode: "ai",
      model_provider: "local",
      model_id: "whisper.cpp/small",
      prompt_version: "audio-transcription-v1",
    },
  );
  assert.equal(result.resources[0].metadata.acquisition_mode, "local_asr");
  assert.equal(result.resources[1].metadata.transcript_acquisition_mode, "local_asr");

  const transcriptPath = result.artifacts[0].uri.replace(/^file:\/\//, "");
  assert.equal(readFileSync(transcriptPath, "utf-8"), `${secretTranscript}\n`);
  assert.equal(statSync(transcriptPath).mode & 0o777, 0o600);
});
