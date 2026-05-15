import * as assert from "assert";
import * as vscode from "vscode";
import {
  inferCapabilities,
  getModelDisplayName,
  getModelDetail,
  registerModelProvider,
  resolveCloudflareReasoningEffort,
  toCloudflareMessages,
  toCloudflareTools,
  toCloudflareToolChoice,
} from "./model-provider";
import type { CloudflareModel } from "./cloudflare-client";
import { createMockExtensionContext } from "./test-utils";

const mockContext = createMockExtensionContext();

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
    test("derives family and version from the model handle", () => {
      const provider = registerModelProvider(mockContext).provider;

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
        assert.strictEqual(
          (model as { category?: unknown }).category,
          undefined,
          "category should no longer be emitted; VS Code 1.120+ groups by provider natively",
        );
        assert.strictEqual(model.priceCategory, "low");
      } finally {
        provider.dispose();
      }
    });

    test("emits a high priceCategory for hosted provider-prefixed handles", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              id: "openai/gpt-5",
              name: "gpt-5",
              provider: { id: "openai", name: "OpenAI" },
              task: { id: "t", name: "Text Generation" },
            }),
            makeModel({
              id: "openai/gpt-5-mini",
              name: "gpt-5-mini",
              provider: { id: "openai", name: "OpenAI" },
              task: { id: "t", name: "Text Generation" },
            }),
          ],
          "acct",
          "key",
        );

        const [gpt5, gpt5Mini] = provider.getRegisteredModels();
        assert.strictEqual(gpt5.priceCategory, "high");
        assert.strictEqual(gpt5Mini.priceCategory, "medium");
      } finally {
        provider.dispose();
      }
    });

    test("hints apply-patch as the preferred edit tool for Claude and OpenAI families", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              id: "anthropic/claude-sonnet-4-5",
              name: "claude-sonnet-4-5",
              provider: { id: "anthropic", name: "Anthropic" },
              task: { id: "t", name: "Text Generation" },
              detectedCapabilities: { toolCalling: true },
            }),
            makeModel({
              id: "openai/gpt-5",
              name: "gpt-5",
              provider: { id: "openai", name: "OpenAI" },
              task: { id: "t", name: "Text Generation" },
              detectedCapabilities: { toolCalling: true },
            }),
            makeModel({
              name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
              task: { id: "t", name: "Text Generation" },
              detectedCapabilities: { toolCalling: true },
            }),
          ],
          "acct",
          "key",
        );

        const byId = new Map(provider.getRegisteredModels().map((m) => [m.id, m]));
        assert.deepStrictEqual(byId.get("anthropic/claude-sonnet-4-5")?.capabilities.editTools, [
          "apply-patch",
        ]);
        assert.deepStrictEqual(byId.get("openai/gpt-5")?.capabilities.editTools, ["apply-patch"]);
        assert.strictEqual(
          byId.get("@cf/meta/llama-3.3-70b-instruct-fp8-fast")?.capabilities.editTools,
          undefined,
        );
      } finally {
        provider.dispose();
      }
    });

    test("orders richer stable chat models ahead of preview variants", () => {
      const provider = registerModelProvider(mockContext).provider;

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

    test("adds a Think Effort picker when the model exposes effort levels", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              id: "reasoning-id",
              name: "openai/gpt-5-mini",
              task: { id: "t", name: "Text Generation" },
              detectedCapabilities: { reasoning: true },
              reasoningEffortLevels: ["low", "medium", "high"],
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.deepStrictEqual(model.configurationSchema?.properties?.reasoningEffort.enum, [
          "low",
          "medium",
          "high",
        ]);
        assert.strictEqual(
          model.configurationSchema?.properties?.reasoningEffort.default,
          "medium",
        );
      } finally {
        provider.dispose();
      }
    });
  });

  suite("resolveCloudflareReasoningEffort", () => {
    test("prefers modelConfiguration over request modelOptions and global fallback", () => {
      const effort = resolveCloudflareReasoningEffort(
        {
          detectedCapabilities: { reasoning: true },
          reasoningEffortLevels: ["low", "medium", "high"],
        },
        {
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          modelOptions: { reasoningEffort: "low" },
          modelConfiguration: { reasoningEffort: "high" },
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        "medium",
      );

      assert.strictEqual(effort, "high");
    });

    test("ignores unsupported values when the model exposes explicit levels", () => {
      const effort = resolveCloudflareReasoningEffort(
        {
          detectedCapabilities: { reasoning: true },
          reasoningEffortLevels: ["low", "medium", "high"],
        },
        {
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          modelOptions: { reasoning_effort: "low" },
          modelConfiguration: { reasoningEffort: "xhigh" },
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        "max",
      );

      assert.strictEqual(effort, "low");
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

    test("maps supported audio data parts into Cloudflare input_audio content", () => {
      const audioPart = new vscode.LanguageModelDataPart(Uint8Array.from([1, 2, 3]), "audio/mpeg");
      const msgs = toCloudflareMessages([userMsg(audioPart)]);

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].role, "user");
      assert.ok(Array.isArray(msgs[0].content));
      if (!Array.isArray(msgs[0].content)) {
        assert.fail("Expected structured content array");
      }

      assert.strictEqual(msgs[0].content[0].type, "input_audio");
      assert.strictEqual(msgs[0].content[0].input_audio.format, "mp3");
      assert.strictEqual(msgs[0].content[0].input_audio.data, "AQID");
    });

    test("rejects unsupported audio data parts", () => {
      const audioPart = new vscode.LanguageModelDataPart(Uint8Array.from([1, 2, 3]), "audio/ogg");

      assert.throws(() => toCloudflareMessages([userMsg(audioPart)]), /audio\/ogg/);
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

    test("emits '' for empty tool result content", () => {
      const toolResult = new vscode.LanguageModelToolResultPart("call-empty", [
        new vscode.LanguageModelTextPart("   "),
      ]);
      const msgs = toCloudflareMessages([userMsg(toolResult)]);
      assert.strictEqual(msgs[0].content, "");
    });
  });

  suite("provider token accounting", () => {
    test("derives effective maxInputTokens from model metadata", () => {
      const provider = registerModelProvider(mockContext).provider;

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
        assert.strictEqual(model.maxInputTokens, 16364);
        assert.strictEqual(model.maxOutputTokens, 4096);
      } finally {
        provider.dispose();
      }
    });

    test("uses compat fallback context limits for AI Gateway models", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              id: "openai/gpt-5-mini",
              name: "gpt-5-mini",
              source: "ai-gateway",
              transport: "compat",
              detectedCapabilities: { toolCalling: true },
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxInputTokens, 127972);
        assert.strictEqual(model.maxOutputTokens, 8192);
      } finally {
        provider.dispose();
      }
    });

    test("uses numeric token hints from compat model handles", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              id: "openai/gpt-4-32k",
              name: "gpt-4-32k",
              source: "ai-gateway",
              transport: "compat",
              detectedCapabilities: { toolCalling: true },
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxInputTokens, 32740);
      } finally {
        provider.dispose();
      }
    });

    test("uses detectedMaxOutputTokens from schema when no output property is set", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels([makeModel({ detectedMaxOutputTokens: 32768 })], "acct", "key");

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxOutputTokens, 32768);
      } finally {
        provider.dispose();
      }
    });

    test("output property takes priority over detectedMaxOutputTokens", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              properties: [{ property_id: "max_new_tokens", value: "8192" }],
              detectedMaxOutputTokens: 32768,
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxOutputTokens, 8192);
      } finally {
        provider.dispose();
      }
    });

    test("prefers explicit max_input_tokens over a larger context window", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              properties: [
                { property_id: "context_window", value: "153600" },
                { property_id: "max_input_tokens", value: "512" },
              ],
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxInputTokens, 492);
      } finally {
        provider.dispose();
      }
    });

    test("prefers max_input_length over total context window", () => {
      const provider = registerModelProvider(mockContext).provider;

      try {
        provider.updateModels(
          [
            makeModel({
              properties: [
                { property_id: "context_window", value: "4096" },
                { property_id: "max_input_length", value: "3072" },
                { property_id: "max_total_tokens", value: "4096" },
              ],
            }),
          ],
          "acct",
          "key",
        );

        const model = provider.getRegisteredModels()[0];
        assert.strictEqual(model.maxInputTokens, 3052);
      } finally {
        provider.dispose();
      }
    });

    test("counts message overhead for text and data parts", async () => {
      const provider = registerModelProvider(mockContext).provider;
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
      const provider = registerModelProvider(mockContext).provider;
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
