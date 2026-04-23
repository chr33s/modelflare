import * as assert from "assert";
import * as vscode from "vscode";
import {
  inferCapabilities,
  getModelDisplayName,
  getModelDetail,
  toCloudflareMessages,
  toCloudflareTools,
  toCloudflareToolChoice,
} from "./model-provider";
import type { CloudflareModel } from "./cloudflare-client";

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
});
