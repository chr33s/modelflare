import * as assert from "assert";
import * as vscode from "vscode";
import {
  inferCapabilities,
  getModelDisplayName,
  getModelDetail,
  registerModelProvider,
  toCloudflareMessages,
  toCloudflareTools,
  toCloudflareToolChoice,
} from "./model-provider";
import type { CloudflareModel } from "./cloudflare-client";

const mockContext = {
  workspaceState: { get: () => undefined, update: () => {} },
} as unknown as vscode.ExtensionContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<CloudflareModel> = {}): CloudflareModel {
  return { id: "test-id", name: "@cf/test-model", ...overrides };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("model-provider", () => {
  // -------------------------------------------------------------------------
  // inferCapabilities
  // -------------------------------------------------------------------------

  suite("inferCapabilities", () => {
    test("respects detectedCapabilities.toolCalling=true", () => {
      const caps = inferCapabilities(makeModel({ detectedCapabilities: { toolCalling: true } }));
      assert.strictEqual(caps.toolCalling, true);
    });

    test("respects detectedCapabilities.toolCalling=false", () => {
      const caps = inferCapabilities(makeModel({ detectedCapabilities: { toolCalling: false } }));
      assert.strictEqual(caps.toolCalling, false);
    });

    test("respects detectedCapabilities.imageInput=true", () => {
      const caps = inferCapabilities(makeModel({ detectedCapabilities: { imageInput: true } }));
      assert.strictEqual(caps.imageInput, true);
    });

    test("detects toolCalling from description metadata hint", () => {
      const caps = inferCapabilities(
        makeModel({ description: "Supports function calling and tool calling" }),
      );
      assert.strictEqual(caps.toolCalling, true);
    });

    test("detects imageInput from description metadata hint", () => {
      const caps = inferCapabilities(makeModel({ description: "Supports vision and image input" }));
      assert.strictEqual(caps.imageInput, true);
    });

    test("detects toolCalling from property hint", () => {
      const caps = inferCapabilities(
        makeModel({ properties: [{ property_id: "function_calling", value: "supported" }] }),
      );
      assert.strictEqual(caps.toolCalling, true);
    });

    test("detects imageInput from property hint", () => {
      const caps = inferCapabilities(
        makeModel({ properties: [{ property_id: "image_support", value: "enabled" }] }),
      );
      assert.strictEqual(caps.imageInput, true);
    });

    test("returns false for toolCalling when property value is negative", () => {
      const caps = inferCapabilities(
        makeModel({
          properties: [{ property_id: "function_calling", value: "false" }],
        }),
      );
      assert.strictEqual(caps.toolCalling, false);
    });

    test("returns false for both when no hints or capabilities", () => {
      const caps = inferCapabilities(makeModel({ name: "plain-model", description: "A model" }));
      assert.strictEqual(caps.toolCalling, false);
      assert.strictEqual(caps.imageInput, false);
    });

    test("detectedCapabilities takes precedence over property hints", () => {
      const caps = inferCapabilities(
        makeModel({
          detectedCapabilities: { toolCalling: false },
          properties: [{ property_id: "tool_support", value: "yes" }],
        }),
      );
      assert.strictEqual(caps.toolCalling, false);
    });
  });

  // -------------------------------------------------------------------------
  // getModelDisplayName
  // -------------------------------------------------------------------------

  suite("getModelDisplayName", () => {
    test("returns last segment of slug name starting with @", () => {
      const name = getModelDisplayName(makeModel({ name: "@cf/meta/llama-3" }), "@cf/meta/llama-3");
      assert.strictEqual(name, "llama-3");
    });

    test("returns plain name when not a slug", () => {
      const name = getModelDisplayName(makeModel({ name: "My Model" }), "my-handle");
      assert.strictEqual(name, "My Model");
    });

    test("returns last segment of modelHandle when handle starts with @ and name is absent", () => {
      const name = getModelDisplayName(makeModel({ name: undefined }), "@cf/meta/llama-3");
      assert.strictEqual(name, "llama-3");
    });

    test("returns modelHandle as-is when it does not start with @ and name is absent", () => {
      const name = getModelDisplayName(makeModel({ name: undefined }), "plain-handle");
      assert.strictEqual(name, "plain-handle");
    });

    test("trims whitespace from name before evaluating slug", () => {
      const name = getModelDisplayName(makeModel({ name: "  @cf/meta/llama  " }), "fallback");
      assert.strictEqual(name, "llama");
    });
  });

  // -------------------------------------------------------------------------
  // getModelDetail
  // -------------------------------------------------------------------------

  suite("getModelDetail", () => {
    test("returns undefined when no capabilities are enabled", () => {
      const detail = getModelDetail(makeModel(), { toolCalling: false, imageInput: false });
      assert.strictEqual(detail, undefined);
    });

    test("returns 'Tools' when toolCalling is true", () => {
      const detail = getModelDetail(makeModel(), { toolCalling: true, imageInput: false });
      assert.strictEqual(detail, "Tools");
    });

    test("returns 'Vision' when imageInput is true", () => {
      const detail = getModelDetail(makeModel(), { toolCalling: false, imageInput: true });
      assert.strictEqual(detail, "Vision");
    });

    test("joins multiple capability labels with ' • '", () => {
      const detail = getModelDetail(makeModel(), { toolCalling: true, imageInput: true });
      assert.strictEqual(detail, "Tools • Vision");
    });

    test("includes JSON from detectedCapabilities.structuredOutput", () => {
      const detail = getModelDetail(
        makeModel({ detectedCapabilities: { structuredOutput: true } }),
        { toolCalling: false, imageInput: false },
      );
      assert.ok(detail?.includes("JSON"));
    });

    test("includes Reasoning from detectedCapabilities.reasoning", () => {
      const detail = getModelDetail(makeModel({ detectedCapabilities: { reasoning: true } }), {
        toolCalling: false,
        imageInput: false,
      });
      assert.ok(detail?.includes("Reasoning"));
    });

    test("includes Audio input from detectedCapabilities.audioInput", () => {
      const detail = getModelDetail(makeModel({ detectedCapabilities: { audioInput: true } }), {
        toolCalling: false,
        imageInput: false,
      });
      assert.ok(detail?.includes("Audio input"));
    });

    test("includes Audio output from detectedCapabilities.audioOutput", () => {
      const detail = getModelDetail(makeModel({ detectedCapabilities: { audioOutput: true } }), {
        toolCalling: false,
        imageInput: false,
      });
      assert.ok(detail?.includes("Audio output"));
    });

    test("omits disabled labels and returns only enabled ones", () => {
      const detail = getModelDetail(
        makeModel({ detectedCapabilities: { reasoning: true, structuredOutput: false } }),
        { toolCalling: false, imageInput: false },
      );
      assert.ok(detail?.includes("Reasoning"));
      assert.ok(!detail?.includes("JSON"));
    });
  });

  suite("provider model metadata", () => {
    test("derives family, version, and category from the model handle", () => {
      const provider = registerModelProvider(mockContext);

      try {
        provider.updateModels(
          [
            makeModel({
              name: "@cf/meta/llama-3.1-8b-instruct",
              task: { id: "t", name: "Text Generation" },
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.family, "meta/llama");
        assert.strictEqual(model.version, "3.1");
        assert.strictEqual(model.category?.label, "Meta");
      } finally {
        provider.dispose();
      }
    });

    test("orders richer stable chat models ahead of preview variants", () => {
      const provider = registerModelProvider(mockContext);

      try {
        provider.updateModels(
          [
            makeModel({
              id: "preview-id",
              name: "@cf/meta/llama-4-preview",
              description: "Experimental preview model",
              task: { id: "t", name: "Text Generation" },
            }),
            makeModel({
              id: "stable-id",
              name: "@cf/meta/llama-3.3-8b-instruct",
              task: { id: "t", name: "Text Generation" },
              detectedCapabilities: { toolCalling: true, structuredOutput: true },
            }),
          ],
          "acct",
          "key",
        );

        assert.strictEqual(provider.getRegisteredModels()[0].id, "@cf/meta/llama-3.3-8b-instruct");
      } finally {
        provider.dispose();
      }
    });
  });

  // -------------------------------------------------------------------------
  // toCloudflareTools
  // -------------------------------------------------------------------------

  suite("toCloudflareTools", () => {
    test("returns undefined for undefined input", () => {
      assert.strictEqual(toCloudflareTools(undefined), undefined);
    });

    test("returns undefined for empty array", () => {
      assert.strictEqual(toCloudflareTools([]), undefined);
    });

    test("maps a single tool correctly", () => {
      const tool: vscode.LanguageModelChatTool = {
        name: "myTool",
        description: "Does something",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
      };
      const result = toCloudflareTools([tool]);
      assert.deepStrictEqual(result, [
        {
          type: "function",
          function: { name: "myTool", description: "Does something", parameters: tool.inputSchema },
        },
      ]);
    });

    test("maps multiple tools", () => {
      const tools: vscode.LanguageModelChatTool[] = [
        { name: "a", description: "A", inputSchema: {} },
        { name: "b", description: "B", inputSchema: {} },
      ];
      const result = toCloudflareTools(tools);
      assert.strictEqual(result?.length, 2);
      assert.strictEqual(result?.[0].function.name, "a");
      assert.strictEqual(result?.[1].function.name, "b");
    });
  });

  // -------------------------------------------------------------------------
  // toCloudflareToolChoice
  // -------------------------------------------------------------------------

  suite("toCloudflareToolChoice", () => {
    const tool: vscode.LanguageModelChatTool = {
      name: "t",
      description: "",
      inputSchema: {},
    };

    test("returns undefined when tools is undefined", () => {
      assert.strictEqual(
        toCloudflareToolChoice(vscode.LanguageModelChatToolMode.Auto, undefined),
        undefined,
      );
    });

    test("returns undefined when tools array is empty", () => {
      assert.strictEqual(
        toCloudflareToolChoice(vscode.LanguageModelChatToolMode.Required, []),
        undefined,
      );
    });

    test("returns 'required' for Required mode", () => {
      assert.strictEqual(
        toCloudflareToolChoice(vscode.LanguageModelChatToolMode.Required, [tool]),
        "required",
      );
    });

    test("returns 'auto' for Auto mode", () => {
      assert.strictEqual(
        toCloudflareToolChoice(vscode.LanguageModelChatToolMode.Auto, [tool]),
        "auto",
      );
    });
  });

  // -------------------------------------------------------------------------
  // toCloudflareMessages
  // -------------------------------------------------------------------------

  suite("toCloudflareMessages", () => {
    function userMsg(
      ...parts: vscode.LanguageModelChatRequestMessage["content"]
    ): vscode.LanguageModelChatRequestMessage {
      return { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: parts };
    }

    function assistantMsg(
      ...parts: vscode.LanguageModelChatRequestMessage["content"]
    ): vscode.LanguageModelChatRequestMessage {
      return {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: parts,
      };
    }

    test("maps a simple user text message", () => {
      const msgs = toCloudflareMessages([userMsg(new vscode.LanguageModelTextPart("Hello"))]);
      assert.deepStrictEqual(msgs, [{ role: "user", content: "Hello" }]);
    });

    test("maps a simple assistant text message", () => {
      const msgs = toCloudflareMessages([
        assistantMsg(new vscode.LanguageModelTextPart("Hi there")),
      ]);
      assert.deepStrictEqual(msgs, [{ role: "assistant", content: "Hi there" }]);
    });

    test("concatenates multiple text parts into one content string", () => {
      const msgs = toCloudflareMessages([
        userMsg(
          new vscode.LanguageModelTextPart("Hello "),
          new vscode.LanguageModelTextPart("world"),
        ),
      ]);
      assert.deepStrictEqual(msgs, [{ role: "user", content: "Hello world" }]);
    });

    test("skips messages with empty content", () => {
      const msgs = toCloudflareMessages([userMsg(new vscode.LanguageModelTextPart(""))]);
      assert.deepStrictEqual(msgs, []);
    });

    test("maps assistant message with tool calls", () => {
      const toolCall = new vscode.LanguageModelToolCallPart("call-1", "myFunc", { x: 1 });
      const msgs = toCloudflareMessages([assistantMsg(toolCall)]);

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].role, "assistant");
      assert.strictEqual(msgs[0].tool_calls?.length, 1);
      assert.strictEqual(msgs[0].tool_calls?.[0].id, "call-1");
      assert.strictEqual(msgs[0].tool_calls?.[0].function.name, "myFunc");
    });

    test("maps user message with tool results as separate tool-role messages", () => {
      const toolResult = new vscode.LanguageModelToolResultPart("call-1", [
        new vscode.LanguageModelTextPart("result-value"),
      ]);
      const msgs = toCloudflareMessages([userMsg(toolResult)]);

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].role, "tool");
      assert.strictEqual(msgs[0].tool_call_id, "call-1");
      assert.strictEqual(msgs[0].content, "result-value");
    });

    test("maps text data parts into message text content", () => {
      const dataPart = vscode.LanguageModelDataPart.text("attached context", "text/plain");
      const msgs = toCloudflareMessages([userMsg(dataPart)]);

      assert.deepStrictEqual(msgs, [{ role: "user", content: "attached context" }]);
    });

    test("maps image data parts into Cloudflare image_url content", () => {
      const imagePart = vscode.LanguageModelDataPart.image(Uint8Array.from([1, 2, 3]), "image/png");
      const msgs = toCloudflareMessages([userMsg(imagePart)]);

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].role, "user");
      assert.ok(Array.isArray(msgs[0].content));
      if (!Array.isArray(msgs[0].content)) {
        assert.fail("Expected structured content array");
      }

      assert.strictEqual(msgs[0].content[0].type, "image_url");
      assert.ok(msgs[0].content[0].image_url.url.startsWith("data:image/png;base64,"));
    });

    test("serializes JSON data parts inside tool results", () => {
      const toolResult = new vscode.LanguageModelToolResultPart("call-json", [
        vscode.LanguageModelDataPart.json({ ok: true }),
      ]);
      const msgs = toCloudflareMessages([userMsg(toolResult)]);

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].role, "tool");
      assert.ok(typeof msgs[0].content === "string");
      if (typeof msgs[0].content !== "string") {
        assert.fail("Expected serialized tool result content");
      }

      assert.ok(/"ok"\s*:\s*true/.test(msgs[0].content), msgs[0].content);
    });

    test("preserves message order across multiple messages", () => {
      const msgs = toCloudflareMessages([
        userMsg(new vscode.LanguageModelTextPart("first")),
        assistantMsg(new vscode.LanguageModelTextPart("second")),
        userMsg(new vscode.LanguageModelTextPart("third")),
      ]);
      assert.strictEqual(msgs.length, 3);
      assert.strictEqual(msgs[0].content, "first");
      assert.strictEqual(msgs[1].content, "second");
      assert.strictEqual(msgs[2].content, "third");
    });

    test("emits '{}' for empty tool result content", () => {
      const toolResult = new vscode.LanguageModelToolResultPart("call-empty", [
        new vscode.LanguageModelTextPart("   "),
      ]);
      const msgs = toCloudflareMessages([userMsg(toolResult)]);
      assert.strictEqual(msgs[0].content, "{}");
    });
  });

  suite("provider token accounting", () => {
    test("derives effective maxInputTokens from model metadata", () => {
      const provider = registerModelProvider(mockContext);

      try {
        provider.updateModels(
          [
            makeModel({
              properties: [{ property_id: "context window", value: "16k" }],
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxInputTokens, 15980);
        assert.strictEqual(model.maxOutputTokens, 4096);
      } finally {
        provider.dispose();
      }
    });

    test("counts message overhead for text and data parts", async () => {
      const provider = registerModelProvider(mockContext);
      const tokenSource = new vscode.CancellationTokenSource();

      try {
        provider.updateModels([makeModel()], "acct", "key");
        const model = provider.getRegisteredModels()[0];
        const message: vscode.LanguageModelChatRequestMessage = {
          role: vscode.LanguageModelChatMessageRole.User,
          name: "tester",
          content: [
            new vscode.LanguageModelTextPart("hello"),
            vscode.LanguageModelDataPart.text("world", "text/plain"),
          ],
        };

        const tokenCount = await provider.provideTokenCount(model, message, tokenSource.token);
        assert.ok(
          tokenCount > 4,
          `Expected message token count to include overhead, got ${tokenCount}`,
        );
      } finally {
        tokenSource.dispose();
        provider.dispose();
      }
    });

    test("rejects requests that exceed the estimated context window", async () => {
      const provider = registerModelProvider(mockContext);
      const tokenSource = new vscode.CancellationTokenSource();

      try {
        provider.updateModels(
          [
            makeModel({
              properties: [{ property_id: "context window", value: "1k" }],
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        const message: vscode.LanguageModelChatRequestMessage = {
          role: vscode.LanguageModelChatMessageRole.User,
          name: undefined,
          content: [new vscode.LanguageModelTextPart("x".repeat(8_000))],
        };

        await assert.rejects(
          async () =>
            provider.provideLanguageModelChatResponse(
              model,
              [message],
              {
                toolMode: vscode.LanguageModelChatToolMode.Auto,
              },
              { report: () => {} },
              tokenSource.token,
            ),
          /exceeds the estimated context window/,
        );
      } finally {
        tokenSource.dispose();
        provider.dispose();
      }
    });
  });
});
