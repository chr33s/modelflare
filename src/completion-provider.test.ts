import * as assert from "assert";
import * as vscode from "vscode";
import { buildCompletionPrompt } from "./completion-provider";
import { registerCompletionProvider } from "./completion-provider";
import type { CloudflareModel } from "./cloudflare-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextGenModel(): CloudflareModel {
  return { id: "tg-id", name: "@cf/llama", task: { id: "t", name: "Text Generation" } };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("completion-provider", () => {
  // -------------------------------------------------------------------------
  // buildCompletionPrompt
  // -------------------------------------------------------------------------

  suite("buildCompletionPrompt", () => {
    async function openDoc(content: string): Promise<vscode.TextDocument> {
      return vscode.workspace.openTextDocument({ content, language: "typescript" });
    }

    test("contains cursor marker", async () => {
      const doc = await openDoc("const x = 1;");
      const pos = new vscode.Position(0, 6);
      const prompt = buildCompletionPrompt(doc, pos);
      assert.ok(prompt.includes("<cursor />"), "Missing <cursor /> marker");
    });

    test("contains before and after sections", async () => {
      const doc = await openDoc("const x = 1;\nconst y = 2;");
      const pos = new vscode.Position(0, 6);
      const prompt = buildCompletionPrompt(doc, pos);
      assert.ok(prompt.includes("<before>"));
      assert.ok(prompt.includes("</before>"));
      assert.ok(prompt.includes("<after>"));
      assert.ok(prompt.includes("</after>"));
    });

    test("puts text before cursor in <before> section", async () => {
      const doc = await openDoc("hello world");
      const pos = new vscode.Position(0, 5);
      const prompt = buildCompletionPrompt(doc, pos);
      const beforeSection = prompt.slice(
        prompt.indexOf("<before>") + "<before>".length,
        prompt.indexOf("</before>"),
      );
      assert.ok(beforeSection.includes("hello"), `Before section: ${beforeSection}`);
      assert.ok(!beforeSection.includes("world"), `Unexpected 'world' in before: ${beforeSection}`);
    });

    test("puts text after cursor in <after> section", async () => {
      const doc = await openDoc("hello world");
      const pos = new vscode.Position(0, 5);
      const prompt = buildCompletionPrompt(doc, pos);
      const afterSection = prompt.slice(
        prompt.indexOf("<after>") + "<after>".length,
        prompt.indexOf("</after>"),
      );
      assert.ok(afterSection.includes("world"), `After section: ${afterSection}`);
    });

    test("contains instruction to return only completion text", async () => {
      const doc = await openDoc("");
      const pos = new vscode.Position(0, 0);
      const prompt = buildCompletionPrompt(doc, pos);
      assert.ok(prompt.toLowerCase().includes("completion"));
    });
  });

  // -------------------------------------------------------------------------
  // registerCompletionProvider
  // -------------------------------------------------------------------------

  suite("registerCompletionProvider", () => {
    test("returns undefined when no models match Text Generation task", () => {
      const models: CloudflareModel[] = [
        { id: "img-id", name: "@cf/img", task: { id: "t", name: "Image Classification" } },
      ];
      const result = registerCompletionProvider(models, "acct", "key");
      assert.strictEqual(result, undefined);
    });

    test("returns undefined when models array is empty", () => {
      const result = registerCompletionProvider([], "acct", "key");
      assert.strictEqual(result, undefined);
    });

    test("returns a Disposable when a Text Generation model is present", () => {
      const result = registerCompletionProvider([makeTextGenModel()], "acct", "key");
      assert.ok(result !== undefined, "Expected a Disposable");
      assert.ok(typeof result.dispose === "function");
      result.dispose();
    });
  });
});
