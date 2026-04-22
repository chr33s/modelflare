import * as vscode from "vscode";
import { CloudflareModel, getCloudflareModelHandle } from "./cloudflare-client";
import { CloudflareRequestState, requestCloudflareChatText } from "./cloudflare-runtime";

const COMPLETION_PREFIX_LINES = 120;
const COMPLETION_SUFFIX_LINES = 40;
const NON_CODE_LANGUAGE_IDS = new Set(["plaintext", "markdown", "json", "jsonc", "log"]);
const TEXT_GENERATION_TASK = "Text Generation";

function buildCompletionPrompt(document: vscode.TextDocument, position: vscode.Position): string {
  const prefixStart = new vscode.Position(Math.max(0, position.line - COMPLETION_PREFIX_LINES), 0);
  const suffixEndLine = Math.min(document.lineCount - 1, position.line + COMPLETION_SUFFIX_LINES);
  const suffixEnd = document.lineAt(suffixEndLine).range.end;
  const before = document.getText(new vscode.Range(prefixStart, position));
  const after = document.getText(new vscode.Range(position, suffixEnd));

  return [
    "Complete the code at <cursor>.",
    "Return only completion text that should be inserted at the cursor.",
    "",
    "<before>",
    before,
    "</before>",
    "<cursor />",
    "<after>",
    after,
    "</after>",
  ].join("\n");
}

async function fetchCompletion(
  modelHandle: string,
  state: CloudflareRequestState,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const text = await requestCloudflareChatText({
    modelHandle,
    state,
    messages: [
      {
        role: "system",
        content:
          "You are a precise code completion engine. Return only the completion with no markdown or explanation.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    token,
    errorLabel: "completion",
    trimEnd: true,
  });

  return text ?? "";
}

export function registerCompletionProvider(
  models: CloudflareModel[],
  accountId: string,
  apiKey: string,
  gatewayId?: string,
): vscode.Disposable | undefined {
  const completionModel = models.find((model) => model.task?.name === TEXT_GENERATION_TASK);
  if (!completionModel) {
    return undefined;
  }

  const completionModelHandle = getCloudflareModelHandle(completionModel);
  const state: CloudflareRequestState = { accountId, apiKey, gatewayId };

  return vscode.languages.registerInlineCompletionItemProvider(
    { scheme: "file" },
    {
      async provideInlineCompletionItems(document, position, _context, token) {
        if (token.isCancellationRequested || position.line < 0) {
          return [];
        }

        if (NON_CODE_LANGUAGE_IDS.has(document.languageId)) {
          return [];
        }

        const prompt = buildCompletionPrompt(document, position);
        const completionText = await fetchCompletion(completionModelHandle, state, prompt, token);
        if (!completionText || token.isCancellationRequested) {
          return [];
        }

        return [
          new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position)),
        ];
      },
    },
  );
}
