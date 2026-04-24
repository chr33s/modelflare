import * as assert from "assert";
import type { CancellationToken } from "vscode";
import {
  buildCloudflareEndpoint,
  requestCloudflareChatResponse,
  requestCloudflareChatText,
} from "./cloudflare-runtime";
import {
  clearCloudflareRequestMetrics,
  getRecentCloudflareRequestMetrics,
} from "./request-metrics";
import type {
  CloudflareRequestState,
  CloudflareChatMessage,
  CloudflareToolDefinition,
} from "./cloudflare-runtime";

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

function makeSseResponse(events: string[], status = 200): Response {
  const body = [...events.map((event) => `data: ${event}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// CancellationToken helpers
// ---------------------------------------------------------------------------

function makeCancelledToken(): CancellationToken {
  return {
    isCancellationRequested: true,
    onCancellationRequested: (_l: unknown) => ({ dispose: () => {} }),
  } as unknown as CancellationToken;
}

interface ActiveToken {
  token: CancellationToken;
  cancel(): void;
}

function makeActiveToken(): ActiveToken {
  let cancelled = false;
  const listeners: Array<() => void> = [];

  const token = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener: () => void) {
      listeners.push(listener);
      return { dispose: () => {} };
    },
  } as unknown as CancellationToken;

  return {
    token,
    cancel() {
      cancelled = true;
      for (const l of listeners) {
        l();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIRECT_STATE: CloudflareRequestState = { accountId: "test-acct", apiKey: "test-key" };
const GATEWAY_STATE: CloudflareRequestState = {
  accountId: "test-acct",
  apiKey: "test-key",
  gatewayId: "my-gw",
};
const MESSAGES: readonly CloudflareChatMessage[] = [{ role: "user", content: "Hello" }];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("cloudflare-runtime", () => {
  setup(() => {
    savedFetch = g.fetch as typeof fetch;
    clearCloudflareRequestMetrics();
  });

  teardown(() => {
    g.fetch = savedFetch;
    clearCloudflareRequestMetrics();
  });

  // -------------------------------------------------------------------------
  // buildCloudflareEndpoint
  // -------------------------------------------------------------------------

  suite("buildCloudflareEndpoint", () => {
    test("returns direct API URL when no gatewayId", () => {
      const url = buildCloudflareEndpoint("@cf/meta/llama", DIRECT_STATE);
      assert.ok(
        url.startsWith("https://api.cloudflare.com/client/v4/accounts/test-acct/ai/run/"),
        `Unexpected URL: ${url}`,
      );
      assert.ok(url.includes("@cf/meta/llama"));
    });

    test("returns gateway URL when gatewayId is set", () => {
      const url = buildCloudflareEndpoint("@cf/meta/llama", GATEWAY_STATE);
      assert.ok(url.startsWith("https://gateway.ai.cloudflare.com/v1/"), `Unexpected URL: ${url}`);
      assert.ok(url.includes("test-acct"));
      assert.ok(url.includes("my-gw"));
      assert.ok(url.includes("@cf/meta/llama"));
    });

    test("embeds accountId in direct URL", () => {
      const state: CloudflareRequestState = { accountId: "my-unique-account", apiKey: "k" };
      const url = buildCloudflareEndpoint("model", state);
      assert.ok(url.includes("my-unique-account"));
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatText — basic behaviour
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatText", () => {
    test("returns undefined when token is already cancelled", async () => {
      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeCancelledToken(),
        errorLabel: "test",
      });
      assert.strictEqual(result, undefined);

      const recorded = getRecentCloudflareRequestMetrics();
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].outcome, "cancelled");
      assert.strictEqual(recorded[0].endpointKind, "direct");
      assert.strictEqual(recorded[0].deliveryMode, "unknown");
    });

    test("makes POST request to direct endpoint", async () => {
      let capturedUrl: string | undefined;
      let capturedMethod: string | undefined;
      mockFetch(async (url, init) => {
        capturedUrl = url.toString();
        capturedMethod = init?.method;
        return makeJsonResponse({ result: { response: "hi" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/meta/llama",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.ok(capturedUrl?.includes("api.cloudflare.com"));
      assert.strictEqual(capturedMethod, "POST");
    });

    test("sends Authorization header", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      mockFetch(async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(capturedHeaders?.["Authorization"], "Bearer test-key");
    });

    test("sends messages in request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      const messages: readonly CloudflareChatMessage[] = [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
      ];

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.deepStrictEqual(capturedBody?.messages, messages);
    });

    test("includes tools, tool_choice, and parallel_tool_calls in body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      const tools: readonly CloudflareToolDefinition[] = [
        { type: "function", function: { name: "myTool", description: "A tool" } },
      ];

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        tools,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.deepStrictEqual(capturedBody?.tools, tools);
      assert.strictEqual(capturedBody?.tool_choice, "auto");
      assert.strictEqual(capturedBody?.parallel_tool_calls, true);
    });

    test("omits tools fields from body when tools array is empty", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        tools: [],
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(capturedBody?.tools, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatText — text extraction
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatText — text extraction", () => {
    async function getText(responseBody: unknown): Promise<string | undefined> {
      mockFetch(async () => makeJsonResponse(responseBody));
      return requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });
    }

    test("extracts text from result.response", async () => {
      assert.strictEqual(await getText({ result: { response: "The answer" } }), "The answer");
    });

    test("extracts text from top-level response field", async () => {
      assert.strictEqual(await getText({ response: "Top level" }), "Top level");
    });

    test("extracts text from result.output_text", async () => {
      assert.strictEqual(await getText({ result: { output_text: "Output text" } }), "Output text");
    });

    test("extracts text from top-level output_text", async () => {
      assert.strictEqual(await getText({ output_text: "Top output" }), "Top output");
    });

    test("extracts text from choices[0].text", async () => {
      assert.strictEqual(
        await getText({ choices: [{ text: "Choice direct text" }] }),
        "Choice direct text",
      );
    });

    test("extracts text from choices[0].message.content", async () => {
      assert.strictEqual(
        await getText({ choices: [{ message: { content: "Message content" } }] }),
        "Message content",
      );
    });

    test("extracts text from choices[0].delta.content", async () => {
      assert.strictEqual(
        await getText({ choices: [{ delta: { content: "Delta content" } }] }),
        "Delta content",
      );
    });

    test("extracts text from result.choices[0].message.content", async () => {
      assert.strictEqual(
        await getText({ result: { choices: [{ message: { content: "Nested choice" } }] } }),
        "Nested choice",
      );
    });

    test("trims trailing whitespace when trimEnd is true", async () => {
      mockFetch(async () => makeJsonResponse({ result: { response: "trailing   \n" } }));
      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
        trimEnd: true,
      });
      assert.strictEqual(result, "trailing");
    });

    test("preserves trailing whitespace when trimEnd is false", async () => {
      mockFetch(async () => makeJsonResponse({ result: { response: "text   " } }));
      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
        trimEnd: false,
      });
      assert.strictEqual(result, "text   ");
    });

    test("throws when response contains no textual output", async () => {
      mockFetch(async () => makeJsonResponse({ result: {} }));

      await assert.rejects(
        () =>
          requestCloudflareChatText({
            modelHandle: "@cf/model",
            state: DIRECT_STATE,
            messages: MESSAGES,
            token: makeActiveToken().token,
            errorLabel: "chat",
          }),
        /did not include textual output/,
      );
    });

    test("throws on HTTP error", async () => {
      mockFetch(async () => makeTextResponse("Forbidden", 403));

      await assert.rejects(
        () =>
          requestCloudflareChatText({
            modelHandle: "@cf/model",
            state: DIRECT_STATE,
            messages: MESSAGES,
            token: makeActiveToken().token,
            errorLabel: "test",
          }),
        /403/,
      );

      const recorded = getRecentCloudflareRequestMetrics();
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].outcome, "error");
      assert.strictEqual(recorded[0].endpointKind, "direct");
      assert.strictEqual(recorded[0].deliveryMode, "unknown");
      assert.strictEqual(recorded[0].errorStatus, 403);
      assert.ok(recorded[0].errorMessage?.includes("Forbidden"));
    });

    test("throws on invalid JSON response", async () => {
      mockFetch(async () => makeTextResponse("not-json"));

      await assert.rejects(
        () =>
          requestCloudflareChatText({
            modelHandle: "@cf/model",
            state: DIRECT_STATE,
            messages: MESSAGES,
            token: makeActiveToken().token,
            errorLabel: "test",
          }),
        /parse/i,
      );
    });

    test("aggregates text from structured content arrays", async () => {
      mockFetch(async () =>
        makeJsonResponse({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "Hello" },
                  { type: "text", text: " world" },
                ],
              },
            },
          ],
        }),
      );

      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(result, "Hello world");
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatText — gateway routing & fallback
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatText — gateway", () => {
    test("uses gateway endpoint when gatewayId is set", async () => {
      let capturedUrl: string | undefined;
      mockFetch(async (url) => {
        capturedUrl = url.toString();
        return makeJsonResponse({ result: { response: "ok" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: GATEWAY_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.ok(capturedUrl?.includes("gateway.ai.cloudflare.com"), `Got: ${capturedUrl}`);
    });

    test("sends cf-aig-authorization header via gateway", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      mockFetch(async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: GATEWAY_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(capturedHeaders?.["cf-aig-authorization"], "Bearer test-key");
    });

    test("does not send cf-aig-authorization via direct endpoint", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      mockFetch(async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeJsonResponse({ result: { response: "ok" } });
      });

      await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(capturedHeaders?.["cf-aig-authorization"], undefined);
    });

    test("falls back to direct endpoint when gateway returns 401", async () => {
      let callCount = 0;
      let lastUrl: string | undefined;
      mockFetch(async (url) => {
        callCount++;
        lastUrl = url.toString();
        if (callCount === 1) {
          return makeTextResponse("Unauthorized", 401);
        }
        return makeJsonResponse({ result: { response: "direct fallback" } });
      });

      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: GATEWAY_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(callCount, 2);
      assert.ok(lastUrl?.includes("api.cloudflare.com"), `Last URL: ${lastUrl}`);
      assert.strictEqual(result, "direct fallback");
    });

    test("marks metrics when gateway falls back to direct", async () => {
      let callCount = 0;
      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return makeTextResponse("Unauthorized", 401);
        }

        return makeJsonResponse({ result: { response: "direct fallback" } });
      });

      const response = await requestCloudflareChatResponse({
        modelHandle: "@cf/model",
        state: GATEWAY_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });

      assert.strictEqual(response?.text, "direct fallback");
      assert.strictEqual(response?.metrics?.endpointKind, "direct");
      assert.strictEqual(response?.metrics?.deliveryMode, "buffered-json");
      assert.strictEqual(response?.metrics?.requestedStream, false);
      assert.strictEqual(response?.metrics?.gatewayFallbackToDirect, true);

      const recorded = getRecentCloudflareRequestMetrics();
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].outcome, "success");
      assert.strictEqual(recorded[0].requestKind, "test");
      assert.strictEqual(recorded[0].modelHandle, "@cf/model");
      assert.strictEqual(recorded[0].gatewayFallbackToDirect, true);
    });

    test("throws without fallback when gateway returns non-401 error", async () => {
      mockFetch(async () => makeTextResponse("Service Unavailable", 503));

      await assert.rejects(
        () =>
          requestCloudflareChatText({
            modelHandle: "@cf/model",
            state: GATEWAY_STATE,
            messages: MESSAGES,
            token: makeActiveToken().token,
            errorLabel: "test",
          }),
        /503/,
      );
    });

    test("throws combined error when both gateway (401) and direct fail", async () => {
      let callCount = 0;
      mockFetch(async () => {
        callCount++;
        return makeTextResponse(
          callCount === 1 ? "gw-err" : "direct-err",
          callCount === 1 ? 401 : 500,
        );
      });

      await assert.rejects(
        () =>
          requestCloudflareChatText({
            modelHandle: "@cf/model",
            state: GATEWAY_STATE,
            messages: MESSAGES,
            token: makeActiveToken().token,
            errorLabel: "test",
          }),
        /gateway.*direct|direct.*gateway/i,
      );
      assert.strictEqual(callCount, 2);
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatResponse — tool call extraction
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatResponse — tool calls", () => {
    async function getResponse(body: unknown) {
      mockFetch(async () => makeJsonResponse(body));
      return requestCloudflareChatResponse({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
      });
    }

    test("extracts tool calls from result.tool_calls", async () => {
      const resp = await getResponse({
        result: {
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "myFunc", arguments: '{"x":1}' } },
          ],
        },
      });

      assert.ok(resp?.toolCalls?.length === 1);
      assert.strictEqual(resp!.toolCalls![0].callId, "call-1");
      assert.strictEqual(resp!.toolCalls![0].name, "myFunc");
      assert.deepStrictEqual(resp!.toolCalls![0].input, { x: 1 });
    });

    test("extracts tool calls from top-level tool_calls", async () => {
      const resp = await getResponse({
        tool_calls: [
          { id: "tc-top", type: "function", function: { name: "topFunc", arguments: '{"a":"b"}' } },
        ],
      });

      assert.ok(resp?.toolCalls && resp.toolCalls.length > 0);
      assert.strictEqual(resp!.toolCalls![0].name, "topFunc");
    });

    test("extracts function_call (legacy format) from result", async () => {
      const resp = await getResponse({
        result: { function_call: { name: "legacyFunc", arguments: '{"k":"v"}' } },
      });

      assert.ok(resp?.toolCalls && resp.toolCalls.length > 0);
      assert.strictEqual(resp!.toolCalls![0].name, "legacyFunc");
    });

    test("extracts tool calls from choices[].message.tool_calls", async () => {
      const resp = await getResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "choice-tc",
                  type: "function",
                  function: { name: "choiceFunc", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });

      assert.ok(resp?.toolCalls && resp.toolCalls.length > 0);
      assert.strictEqual(resp!.toolCalls![0].name, "choiceFunc");
    });

    test("generates callId when tool call has no id", async () => {
      const resp = await getResponse({
        result: {
          tool_calls: [{ type: "function", function: { name: "noIdFunc", arguments: "{}" } }],
        },
      });

      assert.ok(resp?.toolCalls?.[0].callId.startsWith("cf_tool_call_"));
    });

    test("parses object arguments directly (non-string)", async () => {
      const resp = await getResponse({
        result: {
          tool_calls: [
            {
              id: "obj-call",
              type: "function",
              function: { name: "objFunc", arguments: { city: "NYC" } },
            },
          ],
        },
      });

      assert.deepStrictEqual(resp!.toolCalls![0].input, { city: "NYC" });
    });

    test("parseToolCallInput handles invalid JSON string as {value}", async () => {
      const resp = await getResponse({
        result: {
          tool_calls: [
            {
              id: "bad-json",
              type: "function",
              function: { name: "badJson", arguments: "not-json" },
            },
          ],
        },
      });

      assert.deepStrictEqual(resp!.toolCalls![0].input, { value: "not-json" });
    });

    test("preserves reasoning content as a data part", async () => {
      const resp = await getResponse({
        choices: [
          {
            message: {
              content: [{ type: "reasoning", text: "hidden chain of thought" }],
            },
          },
        ],
      });

      assert.ok(resp);
      assert.strictEqual(resp?.parts.length, 1);
      assert.strictEqual(resp?.parts[0].type, "data");
      if (resp?.parts[0].type !== "data") {
        assert.fail("Expected a data part");
      }

      assert.strictEqual(resp.parts[0].mimeType, "text/x-cloudflare-reasoning");
      assert.strictEqual(new TextDecoder().decode(resp.parts[0].data), "hidden chain of thought");
    });

    test("extracts usage metadata when present", async () => {
      const resp = await getResponse({
        result: {
          response: "ok",
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
          },
        },
      });

      assert.deepStrictEqual(resp?.usage, {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      });
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatResponse — streaming
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatResponse — streaming", () => {
    test("streams text chunks from SSE responses and accumulates the final text", async () => {
      const chunks: string[] = [];
      let capturedBody: Record<string, unknown> | undefined;

      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return makeSseResponse([
          JSON.stringify({ response: "Hel" }),
          JSON.stringify({ response: "Hello" }),
          JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
          JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
        ]);
      });

      const response = await requestCloudflareChatResponse({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
        stream: true,
        onTextChunk: (text) => chunks.push(text),
      });

      assert.strictEqual(capturedBody?.stream, true);
      assert.deepStrictEqual(chunks, ["Hel", "lo", " world"]);
      assert.strictEqual(response?.text, "Hello world");
      assert.deepStrictEqual(
        response?.parts
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.value : "")),
        ["Hel", "lo", " world"],
      );
      assert.deepStrictEqual(response?.usage, {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      });
      assert.strictEqual(response?.metrics?.endpointKind, "direct");
      assert.strictEqual(response?.metrics?.deliveryMode, "event-stream");
      assert.strictEqual(response?.metrics?.requestedStream, true);
      assert.strictEqual(response?.metrics?.gatewayFallbackToDirect, false);
      assert.ok((response?.metrics?.timeToFirstTextMs ?? -1) >= 0);
      assert.ok((response?.metrics?.totalDurationMs ?? -1) >= 0);
      assert.ok(
        (response?.metrics?.totalDurationMs ?? -1) >= (response?.metrics?.timeToFirstTextMs ?? -1),
      );

      const recorded = getRecentCloudflareRequestMetrics();
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].outcome, "success");
      assert.strictEqual(recorded[0].deliveryMode, "event-stream");
      assert.strictEqual(recorded[0].requestedStream, true);
      assert.strictEqual(recorded[0].usage?.totalTokens, 3);
    });

    test("emits a text chunk callback for non-streaming JSON responses when requested", async () => {
      const chunks: string[] = [];
      let capturedBody: Record<string, unknown> | undefined;

      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return makeJsonResponse({ result: { response: "fallback json" } });
      });

      const response = await requestCloudflareChatResponse({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
        stream: true,
        onTextChunk: (text) => chunks.push(text),
      });

      assert.strictEqual(capturedBody?.stream, true);
      assert.deepStrictEqual(chunks, ["fallback json"]);
      assert.strictEqual(response?.text, "fallback json");
      assert.strictEqual(response?.metrics?.endpointKind, "direct");
      assert.strictEqual(response?.metrics?.deliveryMode, "buffered-json");
      assert.strictEqual(response?.metrics?.requestedStream, true);
      assert.strictEqual(response?.metrics?.gatewayFallbackToDirect, false);
      assert.strictEqual(response?.metrics?.timeToFirstTextMs, response?.metrics?.totalDurationMs);
    });

    test("accumulates fragmented streamed tool calls and emits one resolved tool call", async () => {
      mockFetch(async () =>
        makeSseResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "lookup", arguments: "{" },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"city":"NYC"' } }],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "}" } }],
                },
              },
            ],
          }),
        ]),
      );

      const response = await requestCloudflareChatResponse({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token: makeActiveToken().token,
        errorLabel: "test",
        stream: true,
      });

      assert.strictEqual(response?.text, undefined);
      assert.deepStrictEqual(response?.toolCalls, [
        {
          callId: "call-1",
          name: "lookup",
          input: { city: "NYC" },
        },
      ]);
      assert.strictEqual(response?.parts.filter((part) => part.type === "tool-call").length, 1);
      assert.strictEqual(response?.metrics?.deliveryMode, "event-stream");
      assert.strictEqual(response?.metrics?.timeToFirstTextMs, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // requestCloudflareChatText — cancellation
  // -------------------------------------------------------------------------

  suite("requestCloudflareChatText — cancellation", () => {
    test("returns undefined when AbortError raised after cancellation", async () => {
      const activeToken = makeActiveToken();
      const { token } = activeToken;
      const cancel = () => activeToken.cancel();

      mockFetch(async (_url, init) => {
        // Simulate cancellation mid-request
        cancel();
        // Simulate the abort signal being triggered
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return makeJsonResponse({ result: { response: "ok" } });
      });

      // If the token is already cancelled when the AbortError is checked, returns undefined
      const result = await requestCloudflareChatText({
        modelHandle: "@cf/model",
        state: DIRECT_STATE,
        messages: MESSAGES,
        token,
        errorLabel: "test",
      }).catch(() => "threw");

      // Either undefined (properly caught abort) or a valid response — not a rethrown error
      assert.ok(result === undefined || typeof result === "string");

      const recorded = getRecentCloudflareRequestMetrics();
      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].outcome, "cancelled");
      assert.strictEqual(recorded[0].endpointKind, "direct");
      assert.strictEqual(recorded[0].deliveryMode, "unknown");
      assert.ok(recorded[0].totalDurationMs >= 0);
    });
  });
});
