import * as assert from "assert";
import {
  fetchCloudflareAiGatewayModels,
  getCloudflareModelHandle,
  fetchCloudflareModels,
  getCloudflareModelFamily,
  getCloudflareModelPickerCategory,
  getCloudflareModelVersion,
  enrichCloudflareModelsWithCapabilities,
  parseManualCloudflareModels,
  selectCloudflareCompletionModel,
  sortCloudflareModels,
} from "./cloudflare-client";
import type { CloudflareModel } from "./cloudflare-client";
import {
  makeJsonResponse,
  makeTextResponse,
  mockFetch,
  restoreGlobalFetch,
  saveGlobalFetch,
} from "./test-utils";
import {
  LATEST_MODEL_FILTER,
  LATEST_STABLE_MODEL_FILTER,
  TEXT_GENERATION_MODEL_FILTER,
} from "./model-filter";

let savedFetch: typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextGenModel(id: string, name: string): CloudflareModel {
  return { id, name, task: { id: "tg-task", name: "Text Generation" } };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("cloudflare-client", () => {
  setup(() => {
    savedFetch = saveGlobalFetch();
  });

  teardown(() => {
    restoreGlobalFetch(savedFetch);
  });

  // -------------------------------------------------------------------------
  // getCloudflareModelHandle
  // -------------------------------------------------------------------------

  suite("getCloudflareModelHandle", () => {
    test("returns name when name starts with @", () => {
      assert.strictEqual(
        getCloudflareModelHandle({ id: "uuid-1", name: "@cf/meta/llama-3" }),
        "@cf/meta/llama-3",
      );
    });

    test("returns trimmed name starting with @", () => {
      assert.strictEqual(
        getCloudflareModelHandle({ id: "uuid-2", name: "  @cf/meta/llama-3  " }),
        "@cf/meta/llama-3",
      );
    });

    test("returns id when name does not start with @", () => {
      assert.strictEqual(getCloudflareModelHandle({ id: "uuid-3", name: "llama-3" }), "uuid-3");
    });

    test("returns id when name is undefined", () => {
      assert.strictEqual(getCloudflareModelHandle({ id: "uuid-4" }), "uuid-4");
    });

    test("returns id when name is empty string", () => {
      assert.strictEqual(getCloudflareModelHandle({ id: "uuid-5", name: "" }), "uuid-5");
    });

    test("returns id when name is only whitespace", () => {
      assert.strictEqual(getCloudflareModelHandle({ id: "uuid-6", name: "   " }), "uuid-6");
    });
  });

  // -------------------------------------------------------------------------
  // fetchCloudflareModels
  // -------------------------------------------------------------------------

  suite("fetchCloudflareModels", () => {
    test("returns model array on success", async () => {
      const models: CloudflareModel[] = [
        { id: "m1", name: "@cf/model-one" },
        { id: "m2", name: "@cf/model-two" },
      ];
      mockFetch(async () => makeJsonResponse({ success: true, result: models, errors: [] }));

      const result = await fetchCloudflareModels("acct", "key", TEXT_GENERATION_MODEL_FILTER);
      assert.deepStrictEqual(result, [
        {
          id: "m1",
          name: "@cf/model-one",
          provider: undefined,
          source: "workers-ai",
          transport: "direct",
        },
        {
          id: "m2",
          name: "@cf/model-two",
          provider: undefined,
          source: "workers-ai",
          transport: "direct",
        },
      ]);
    });

    test("fetches multiple pages and de-duplicates by model handle", async () => {
      const capturedUrls: string[] = [];
      mockFetch(async (url) => {
        capturedUrls.push(url.toString());
        const page = new URL(url.toString()).searchParams.get("page");
        if (page === "1") {
          return makeJsonResponse({
            success: true,
            result: [
              { id: "m1", name: "@cf/model-one" },
              { id: "m2", name: "@cf/model-two" },
            ],
            result_info: { page: 1, total_pages: 2 },
            errors: [],
          });
        }

        return makeJsonResponse({
          success: true,
          result: [
            { id: "m2-duplicate", name: "@cf/model-two" },
            { id: "m3", name: "@cf/model-three" },
          ],
          result_info: { page: 2, total_pages: 2 },
          errors: [],
        });
      });

      const result = await fetchCloudflareModels("acct", "key", "all");
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(
        result.map((model) => getCloudflareModelHandle(model)),
        ["@cf/model-one", "@cf/model-two", "@cf/model-three"],
      );
      assert.ok(capturedUrls[0]?.includes("page=1"));
      assert.ok(capturedUrls[1]?.includes("page=2"));
    });

    test("sends Authorization header", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      mockFetch(async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "my-api-key", "all");
      assert.strictEqual(capturedHeaders?.["Authorization"], "Bearer my-api-key");
    });

    test("applies task query param for non-all filter", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "key", TEXT_GENERATION_MODEL_FILTER);

      assert.ok(
        capturedUrl?.includes("task=text-generation"),
        `Expected task param in URL, got: ${capturedUrl}`,
      );
    });

    test("passes through latest-style filter values to the Workers AI API", async () => {
      const capturedUrls: string[] = [];
      mockFetch(async (url) => {
        capturedUrls.push(url.toString());
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "key", LATEST_MODEL_FILTER);
      await fetchCloudflareModels("acct", "key", LATEST_STABLE_MODEL_FILTER);

      assert.ok(capturedUrls[0]?.includes("task=latest"), capturedUrls[0]);
      assert.ok(capturedUrls[1]?.includes("task=latest-stable"), capturedUrls[1]);
    });

    test("omits task query param for 'all' filter", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "key", "all");
      assert.ok(!capturedUrl?.includes("task="), `Unexpected task param in URL: ${capturedUrl}`);
    });

    test("uses text-generation filter by default", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "key");
      assert.ok(
        capturedUrl?.includes("task=text-generation"),
        `Expected task param in URL, got: ${capturedUrl}`,
      );
    });

    test("includes accountId in URL", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("my-account-id", "key", "all");
      assert.ok(capturedUrl?.includes("my-account-id"));
    });

    test("throws on HTTP error", async () => {
      mockFetch(async () => makeTextResponse("Unauthorized", 401));

      await assert.rejects(
        () => fetchCloudflareModels("acct", "bad-key", TEXT_GENERATION_MODEL_FILTER),
        /401/,
      );
    });

    test("throws on invalid JSON response", async () => {
      mockFetch(async () => makeTextResponse("not-json"));

      await assert.rejects(
        () => fetchCloudflareModels("acct", "key", TEXT_GENERATION_MODEL_FILTER),
        /parse/i,
      );
    });

    test("throws when success is false with error messages", async () => {
      mockFetch(async () =>
        makeJsonResponse({
          success: false,
          result: [],
          errors: [{ message: "Invalid API key" }],
        }),
      );

      await assert.rejects(
        () => fetchCloudflareModels("acct", "key", TEXT_GENERATION_MODEL_FILTER),
        /Invalid API key/,
      );
    });
  });

  suite("fetchCloudflareAiGatewayModels", () => {
    test("parses supported-model markdown into provider-prefixed model handles", async () => {
      mockFetch(async () =>
        makeTextResponse(`| Provider | Model |
| --- | --- |
| [OpenAI](/ai-gateway/usage/providers/openai/) | gpt-5-mini |
| [Google AI Studio](/ai-gateway/usage/providers/google-ai-studio/) | gemini-2.5-flash |
| [Anthropic](/ai-gateway/usage/providers/anthropic/) | claude-sonnet-4-5 |
| [OpenAI](/ai-gateway/usage/providers/openai/) | text-embedding-3-small |
`),
      );

      const result = await fetchCloudflareAiGatewayModels();

      assert.deepStrictEqual(
        result.map((model) => getCloudflareModelHandle(model)),
        ["openai/gpt-5-mini", "google-ai-studio/gemini-2.5-flash", "anthropic/claude-sonnet-4-5"],
      );
      assert.strictEqual(result[0]?.detectedCapabilities?.toolCalling, true);
      assert.deepStrictEqual(result[0]?.reasoningEffortLevels, ["low", "medium", "high"]);
      assert.strictEqual(result[1]?.provider?.name, "Google AI Studio");
      assert.deepStrictEqual(result[1]?.reasoningEffortLevels, ["low", "medium", "high"]);
      assert.deepStrictEqual(result[2]?.reasoningEffortLevels, ["low", "medium", "high"]);
    });

    test("respects provider allowlists and all-filter mode", async () => {
      mockFetch(async () =>
        makeTextResponse(`| Provider | Model |
| --- | --- |
| [OpenAI](/ai-gateway/usage/providers/openai/) | gpt-5-mini |
| [OpenAI](/ai-gateway/usage/providers/openai/) | text-embedding-3-small |
| [Anthropic](/ai-gateway/usage/providers/anthropic/) | claude-sonnet-4-5 |
`),
      );

      const result = await fetchCloudflareAiGatewayModels("all", ["openai"]);

      assert.deepStrictEqual(
        result.map((model) => getCloudflareModelHandle(model)),
        ["openai/gpt-5-mini", "openai/text-embedding-3-small"],
      );
      assert.strictEqual(result[1]?.task?.name, "Text Embeddings");
    });

    test("treats latest-style filters as text-generation discovery for AI Gateway models", async () => {
      mockFetch(async () =>
        makeTextResponse(`| Provider | Model |
| --- | --- |
| [OpenAI](/ai-gateway/usage/providers/openai/) | gpt-5-mini |
| [OpenAI](/ai-gateway/usage/providers/openai/) | text-embedding-3-small |
`),
      );

      for (const filter of [LATEST_MODEL_FILTER, LATEST_STABLE_MODEL_FILTER]) {
        const result = await fetchCloudflareAiGatewayModels(filter);

        assert.deepStrictEqual(
          result.map((model) => getCloudflareModelHandle(model)),
          ["openai/gpt-5-mini"],
        );
      }
    });
  });

  suite("parseManualCloudflareModels", () => {
    test("normalizes manual handles and inferred transport metadata", () => {
      const result = parseManualCloudflareModels([
        { model: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
        {
          model: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          capabilities: { toolCalling: false },
        },
      ]);

      assert.deepStrictEqual(
        result.models.map((model) => ({
          handle: getCloudflareModelHandle(model),
          transport: model.transport,
          name: model.name,
          toolCalling: model.detectedCapabilities?.toolCalling,
          reasoningEffortLevels: model.reasoningEffortLevels,
        })),
        [
          {
            handle: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            transport: "direct",
            name: "llama-3.3-70b-instruct-fp8-fast",
            toolCalling: undefined,
            reasoningEffortLevels: undefined,
          },
          {
            handle: "openai/gpt-5-mini",
            transport: "compat",
            name: "GPT-5 Mini",
            toolCalling: false,
            reasoningEffortLevels: ["low", "medium", "high"],
          },
        ],
      );
      assert.deepStrictEqual(result.warnings, []);
    });

    test("infers compat reasoning effort levels when manual compat models omit them", () => {
      const result = parseManualCloudflareModels([{ model: "anthropic/claude-sonnet-4-5" }]);

      assert.deepStrictEqual(result.models[0]?.reasoningEffortLevels, ["low", "medium", "high"]);
      assert.strictEqual(result.models[0]?.detectedCapabilities?.reasoning, true);
      assert.deepStrictEqual(result.warnings, []);
    });

    test("reports invalid manual model entries", () => {
      const result = parseManualCloudflareModels(["not-an-object", { model: "   " }]);

      assert.strictEqual(result.models.length, 0);
      assert.strictEqual(result.warnings.length, 2);
    });

    test("keeps manual reasoning effort levels and marks the model as reasoning-capable", () => {
      const result = parseManualCloudflareModels([
        {
          model: "openai/gpt-5-mini",
          reasoningEffortLevels: ["low", " medium ", "high"],
        },
      ]);

      assert.deepStrictEqual(result.models[0].reasoningEffortLevels, ["low", "medium", "high"]);
      assert.strictEqual(result.models[0].detectedCapabilities?.reasoning, true);
      assert.deepStrictEqual(result.warnings, []);
    });
  });

  suite("derived model metadata", () => {
    test("derives family and version from slug handles", () => {
      const model = makeTextGenModel("uuid-1", "@cf/meta/llama-3.1-8b-instruct");

      assert.strictEqual(getCloudflareModelFamily(model), "meta/llama");
      assert.strictEqual(getCloudflareModelVersion(model), "3.1");
    });

    test("derives qwen-style embedded family/version tokens", () => {
      const model = makeTextGenModel("uuid-2", "@cf/qwen/qwen2.5-coder-7b-instruct");

      assert.strictEqual(getCloudflareModelFamily(model), "qwen/qwen-coder");
      assert.strictEqual(getCloudflareModelVersion(model), "2.5");
    });

    test("uses author as the picker category label for text generation models", () => {
      const model = makeTextGenModel("uuid-3", "@cf/mistral/mistral-small-3.1-instruct");

      assert.deepStrictEqual(getCloudflareModelPickerCategory(model), {
        label: "Mistral",
        order: 10,
      });
    });

    test("derives family/category metadata for provider-prefixed compat handles", () => {
      const model: CloudflareModel = {
        id: "openai/gpt-5-mini",
        name: "gpt-5-mini",
        provider: { id: "openai", name: "OpenAI" },
        task: { id: "text-generation", name: "Text Generation" },
      };

      assert.strictEqual(getCloudflareModelFamily(model), "openai/gpt");
      assert.strictEqual(getCloudflareModelVersion(model), "5");
      assert.deepStrictEqual(getCloudflareModelPickerCategory(model), {
        label: "OpenAI",
        order: 10,
      });
    });
  });

  suite("model ordering and completion selection", () => {
    test("sorts richer stable chat models ahead of experimental ones", () => {
      const sorted = sortCloudflareModels([
        {
          ...makeTextGenModel("preview-id", "@cf/meta/llama-4-preview"),
          description: "Experimental preview release",
        },
        {
          ...makeTextGenModel("stable-id", "@cf/meta/llama-3.3-8b-instruct"),
          detectedCapabilities: { toolCalling: true, structuredOutput: true },
        },
      ]);

      assert.strictEqual(getCloudflareModelHandle(sorted[0]), "@cf/meta/llama-3.3-8b-instruct");
    });

    test("selects the explicitly configured completion model when present", () => {
      const selected = selectCloudflareCompletionModel(
        [
          makeTextGenModel("uuid-a", "@cf/meta/llama-3.1-70b-instruct"),
          makeTextGenModel("uuid-b", "@cf/qwen/qwen2.5-coder-7b-instruct"),
        ],
        "@cf/meta/llama-3.1-70b-instruct",
      );

      assert.strictEqual(getCloudflareModelHandle(selected!), "@cf/meta/llama-3.1-70b-instruct");
    });

    test("prefers code-focused smaller models for completion heuristics", () => {
      const selected = selectCloudflareCompletionModel([
        makeTextGenModel("uuid-a", "@cf/meta/llama-3.1-70b-instruct"),
        makeTextGenModel("uuid-b", "@cf/qwen/qwen2.5-coder-7b-instruct"),
      ]);

      assert.strictEqual(getCloudflareModelHandle(selected!), "@cf/qwen/qwen2.5-coder-7b-instruct");
    });
  });

  // -------------------------------------------------------------------------
  // enrichCloudflareModelsWithCapabilities
  // -------------------------------------------------------------------------

  suite("enrichCloudflareModelsWithCapabilities", () => {
    test("returns models unchanged when none are Text Generation", async () => {
      const models: CloudflareModel[] = [
        { id: "img-1", name: "@cf/img", task: { id: "t", name: "Image Classification" } },
      ];

      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, "img-1");
    });

    test("does not call schema API for non-text-generation models", async () => {
      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return makeJsonResponse({});
      });

      await enrichCloudflareModelsWithCapabilities("acct", "key", [
        { id: "sr-unique-abc", task: { id: "t1", name: "Speech Recognition" } },
      ]);

      assert.strictEqual(fetchCalled, false);
    });

    test("does not call schema API for compat text-generation models", async () => {
      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return makeJsonResponse({});
      });

      await enrichCloudflareModelsWithCapabilities("acct", "key", [
        {
          id: "openai/gpt-5-mini",
          name: "gpt-5-mini",
          task: { id: "text-generation", name: "Text Generation" },
          transport: "compat",
        },
      ]);

      assert.strictEqual(fetchCalled, false);
    });

    test("detects tool calling from schema input properties", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: {
                properties: { tools: { type: "array" }, messages: { type: "array" } },
              },
              output: {},
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("tool-uuid-enrich-1", "@cf/tool-model-enrich-1")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result[0].detectedCapabilities?.toolCalling, true);
    });

    test("detects tool calling from schema output properties", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: { properties: { messages: { type: "array" } } },
              output: { properties: { tool_calls: { type: "array" } } },
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("tool-out-uuid-2", "@cf/tool-out-model-2")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result[0].detectedCapabilities?.toolCalling, true);
    });

    test("detects image input from content schema with image_url enum", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: {
                properties: {
                  // Production code finds `content` via messages.properties.content
                  // (getSchemaProperties looks at properties directly, not items.properties)
                  messages: {
                    properties: {
                      content: {
                        anyOf: [
                          { type: "string" },
                          {
                            type: "array",
                            items: { properties: { type: { enum: ["text", "image_url"] } } },
                          },
                        ],
                      },
                    },
                  },
                },
              },
              output: {},
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("vision-uuid-3", "@cf/vision-model-3")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result[0].detectedCapabilities?.imageInput, true);
    });

    test("detects reasoning from reasoning_effort input property", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: {
                properties: {
                  reasoning_effort: { type: "string" },
                  messages: { type: "array" },
                },
              },
              output: {},
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("reason-uuid-4", "@cf/reason-model-4")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result[0].detectedCapabilities?.reasoning, true);
    });

    test("extracts reasoning effort levels from reasoning_effort enum", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: {
                properties: {
                  reasoning_effort: {
                    anyOf: [{ type: "string", enum: ["low", "medium", "high"] }],
                  },
                  messages: { type: "array" },
                },
              },
              output: {},
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("reason-levels-uuid-5", "@cf/reason-levels-model")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.deepStrictEqual(result[0].reasoningEffortLevels, ["low", "medium", "high"]);
    });

    test("detects structured output from response_format input property", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({
            result: {
              input: {
                properties: {
                  messages: { type: "array" },
                  response_format: {
                    properties: { type: { enum: ["text", "json_object", "json_schema"] } },
                  },
                },
              },
              output: {},
            },
          });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("struct-uuid-5", "@cf/struct-model-5")];
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result[0].detectedCapabilities?.structuredOutput, true);
    });

    test("handles schema fetch failure gracefully without throwing", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeTextResponse("Internal Server Error", 500);
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models = [makeTextGenModel("fail-uuid-6", "@cf/fail-schema-model-6")];

      // Must not throw; model is returned without capabilities
      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, "fail-uuid-6");
    });

    test("uses model handle slug as schema query param", async () => {
      let capturedSchemaUrl: string | undefined;
      mockFetch(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes("models/schema")) {
          capturedSchemaUrl = urlStr;
          return makeJsonResponse({ result: { input: {}, output: {} } });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      // Use a unique model handle to avoid hitting the detectedCapabilitiesCache from prior tests
      const models = [makeTextGenModel("slug-unique-uuid-7x", "@cf/slug-model-7x")];
      await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      assert.ok(
        capturedSchemaUrl?.includes("@cf/slug-model-7x") ||
          capturedSchemaUrl?.includes("%40cf%2Fslug-model-7x"),
        `Expected slug in schema URL, got: ${capturedSchemaUrl}`,
      );
    });

    test("preserves existing detectedCapabilities fields", async () => {
      mockFetch(async (url) => {
        if (url.toString().includes("models/schema")) {
          return makeJsonResponse({ result: { input: {}, output: {} } });
        }
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      const models: CloudflareModel[] = [
        {
          ...makeTextGenModel("preserve-uuid-8", "@cf/preserve-model-8"),
          detectedCapabilities: { toolCalling: true },
        },
      ];

      const result = await enrichCloudflareModelsWithCapabilities("acct", "key", models);

      // Original model detectedCapabilities are merged, not wiped
      assert.ok(result[0].detectedCapabilities !== undefined);
    });
  });
});
