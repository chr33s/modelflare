import * as assert from "assert";
import {
  getCloudflareModelHandle,
  fetchCloudflareModels,
  enrichCloudflareModelsWithCapabilities,
} from "./cloudflare-client";
import type { CloudflareModel } from "./cloudflare-client";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
let savedFetch: typeof fetch;

type MockFetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: MockFetchImpl): void {
  g.fetch = impl as typeof fetch;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTextResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

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
    savedFetch = g.fetch as typeof fetch;
  });

  teardown(() => {
    g.fetch = savedFetch;
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

      const result = await fetchCloudflareModels("acct", "key", "Text Generation");
      assert.deepStrictEqual(result, models);
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

      await fetchCloudflareModels("acct", "key", "Text Generation");

      assert.ok(
        capturedUrl?.includes("task=Text+Generation") ||
          capturedUrl?.includes("task=Text%20Generation"),
        `Expected task param in URL, got: ${capturedUrl}`,
      );
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

    test("uses Text Generation filter by default", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ success: true, result: [], errors: [] });
      });

      await fetchCloudflareModels("acct", "key");
      assert.ok(capturedUrl?.includes("task="), `Expected task param in URL, got: ${capturedUrl}`);
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
        () => fetchCloudflareModels("acct", "bad-key", "Text Generation"),
        /401/,
      );
    });

    test("throws on invalid JSON response", async () => {
      mockFetch(async () => makeTextResponse("not-json"));

      await assert.rejects(() => fetchCloudflareModels("acct", "key", "Text Generation"), /parse/i);
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
        () => fetchCloudflareModels("acct", "key", "Text Generation"),
        /Invalid API key/,
      );
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
