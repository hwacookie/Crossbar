/**
 * Regression test: verifies that Crossbar does NOT inject hardcoded maxTokens /
 * contextWindow when the backend does not report them.
 *
 * Before the fix, llamacpp.ts always returned maxTokens: 4096 and
 * contextWindow: 8192 in toPiModel() regardless of what the backend actually
 * reported.  This caused Pi to cap output at ~4k tokens, ignoring the server's
 * own n-predict: 32768 configuration.
 *
 * After the fix, when the backend does not report these values, Crossbar
 * omits them from the PiModelEntry — letting Pi use its own safe defaults
 * (unbounded maxTokens, 128k contextWindow).
 */

import { describe, it, expect } from "vitest";
import { llamacppAdapter } from "../../src/adapters/llamacpp.ts";
import type { DiscoveredServer, ModelDescriptor } from "../../src/core/types.ts";
import type { ProbeResult } from "../../src/core/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(baseUrl = "http://localhost:8080"): DiscoveredServer {
  return {
    kind: "llamacpp",
    baseUrl,
    auth: "none" as const,
    label: `llama.cpp (${baseUrl})`,
    confidence: 0.9,
  };
}

// Mock /props response that EXPLICITLY sets n_predict to a large value
// (32768) — exactly what a real llama.cpp server with --n-predict 32768
// would return.
const PROPS_WITH_N_PREDICT: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    default_generation_settings: {
      n_ctx: 128000,
      n_predict: 32768,  // ← THE VALUE WE WANT Crossbar to read
      temperature: 0.7,
      top_p: 0.95,
    },
    build_info: {
      build_number: 3518,
      commit: "abc1234",
    },
    model_path: "/models/llama-3.1-8b-instruct.Q4_K_M.gguf",
    modalities: ["text"],
  },
};

// Mock /v1/models — single model, no meta.n_ctx_train
const MODELS_NO_META: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  json: {
    object: "list",
    data: [
      {
        id: "llama-3.1-8b-instruct",
        object: "model",
        created: 1719000000,
        owned_by: "llamacpp",
      },
    ],
  },
};

// A model descriptor with NO contextWindow / maxTokens — exactly what happens
// when the backend does not report these values (e.g. a minimal /v1/models
// response with no meta and no /props data).
function descriptorWithoutMetadata(): ModelDescriptor {
  return {
    id: "test-model.gguf",
    name: "test-model",
    input: ["text"],
  };
}

// A model descriptor that DOES report contextWindow (from /props meta).
function descriptorWithMetadata(): ModelDescriptor {
  return {
    id: "test-model.gguf",
    name: "test-model",
    contextWindow: 128000,
    input: ["text"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("llamacpp maxTokens fix (regression)", () => {
  const server = makeServer();

  describe("toPiModel", () => {
    it("omits maxTokens when the model descriptor does not carry one", () => {
      const desc = descriptorWithoutMetadata();
      const entry = llamacppAdapter.toPiModel(server, desc);

      // The key assertion: maxTokens must NOT be present when the backend
      // did not report it.  Before the fix, Crossbar injected 4096 here,
      // causing Pi to cap all output at ~4k tokens.
      expect(entry.maxTokens).toBeUndefined();

      // contextWindow should also be omitted when not reported.
      expect(entry.contextWindow).toBeUndefined();
    });

    it("passes through maxTokens when the model descriptor carries one", () => {
      const desc = descriptorWithMetadata();
      const entry = llamacppAdapter.toPiModel(server, desc);

      // When the backend DOES report contextWindow, it must appear in the
      // PiModelEntry so Pi can use it for compaction.
      expect(entry.contextWindow).toBe(128000);

      // maxTokens should still be undefined when not provided by the backend.
      expect(entry.maxTokens).toBeUndefined();
    });

    it("does NOT inject a 4096 fallback when backend reports nothing", () => {
      const desc = descriptorWithoutMetadata();
      const entry = llamacppAdapter.toPiModel(server, desc);

      // Before the fix, this was 4096 — which caused Pi to cap output at
      // ~4k tokens regardless of what the llama.cpp server was configured
      // with (n-predict: 32768, ctx-size: 128000).
      expect(entry.maxTokens).not.toBe(4096);

      // And 8192 — which caused Pi to cap compaction at ~6.5k tokens.
      expect(entry.contextWindow).not.toBe(8192);

      // Verify the fields are truly absent (not zero, not a default).
      expect(entry).not.toHaveProperty("maxTokens");
      expect(entry).not.toHaveProperty("contextWindow");
    });
  });

  // -----------------------------------------------------------------------
  // Integration test: Crossbar ignores n_predict from /props
  // -----------------------------------------------------------------------
  // This test proves that llamacpp.listModels() DOES fetch /props and
  // reads n_ctx from it, but COMPLETELY IGNORES n_predict.  Instead it
  // hardcodes maxTokens: 4096, causing Pi to cap output at ~4k tokens
  // regardless of what the server was configured with.
  //
  // The fix must: (a) parse n_predict from /props, and (b) pass it
  // through to the ModelDescriptor so toPiModel() can forward it.
  // -----------------------------------------------------------------------

  describe("listModels ignores n_predict from /props (bug)", () => {
    it("returns maxTokens: 4096 even when /props declares n_predict: 32768", async () => {
      const { createFakeProbe } = await import("../conformance/fake-probe.ts");

      const server = makeServer();
      const probe = createFakeProbe({
        "/props": PROPS_WITH_N_PREDICT,
        "/v1/models": MODELS_NO_META,
      });

      const models = await llamacppAdapter.listModels(server, { mode: "none" }, probe);
      expect(models.length).toBe(1);

      // The /props response explicitly sets n_predict to 32768.
      // Before the fix, Crossbar IGNORES this and returns 4096.
      const entry = models[0];

      // BUG: Crossbar ignores n_predict and hardcodes 4096.
      // After the fix, this should be 32768 (or undefined if omitted).
      expect(entry.maxTokens).toBe(4096);  // ← PROVES the bug!

      // The contextWindow IS read from n_ctx (128000 in the fixture).
      // So Crossbar reads SOME values from /props but NOT n_predict.
      expect(entry.contextWindow).toBe(128000);

      // Verify the /props response actually contains n_predict: 32768.
      const propsJson = (PROPS_WITH_N_PREDICT.json as { default_generation_settings?: { n_predict?: number } }).default_generation_settings;
      expect(propsJson?.n_predict).toBe(32768);
    });

    it("returns maxTokens: 4096 when /props omits n_predict entirely", async () => {
      const { createFakeProbe } = await import("../conformance/fake-probe.ts");

      const server = makeServer();
      // /props WITHOUT n_predict — some servers may not report it.
      const propsNoNPredict: ProbeResult = {
        status: 200,
        ok: true,
        headers: { "content-type": "application/json" },
        json: {
          default_generation_settings: {
            n_ctx: 8192,
            temperature: 0.7,
          },
          build_info: { build_number: 3518, commit: "abc" },
          model_path: "/models/model.gguf",
          modalities: ["text"],
        },
      };

      const probe = createFakeProbe({
        "/props": propsNoNPredict,
        "/v1/models": MODELS_NO_META,
      });

      const models = await llamacppAdapter.listModels(server, { mode: "none" }, probe);
      expect(models.length).toBe(1);

      // Before the fix: Crossbar returns 4096 regardless.
      expect(models[0].maxTokens).toBe(4096);
    });
  });
});
