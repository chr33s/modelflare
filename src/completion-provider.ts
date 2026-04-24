import * as vscode from "vscode";
import {
  CloudflareModel,
  getCloudflareModelHandle,
  selectCloudflareCompletionModel,
} from "./cloudflare-client";
import { CloudflareRequestState, requestCloudflareChatText } from "./cloudflare-runtime";

const COMPLETION_PREFIX_LINES = 120;
const COMPLETION_SUFFIX_LINES = 40;
const DEFAULT_COMPLETION_SYSTEM_PROMPT =
  "You are a precise code completion engine. Return only the completion with no markdown or explanation.";
const DEFAULT_COMPLETION_EXCLUDED_LANGUAGE_IDS = [
  "plaintext",
  "markdown",
  "json",
  "jsonc",
  "log",
] as const;

function getCompletionSystemPrompt(): string {
  const configuredPrompt = vscode.workspace
    .getConfiguration("cloudflareCopilot")
    .get<string>("completionSystemPrompt")
    ?.trim();

  return configuredPrompt && configuredPrompt.length > 0
    ? configuredPrompt
    : DEFAULT_COMPLETION_SYSTEM_PROMPT;
}

function getCompletionExcludedLanguages(): ReadonlySet<string> {
  const configuredLanguages = vscode.workspace
    .getConfiguration("cloudflareCopilot")
    .get<string[]>("completionExcludedLanguages");
  const languageIds = configuredLanguages ?? [...DEFAULT_COMPLETION_EXCLUDED_LANGUAGE_IDS];

  return new Set(
    languageIds
      .map((languageId) => languageId.trim())
      .filter((languageId) => languageId.length > 0),
  );
}

export function buildCompletionPrompt(
  modelHandle: string,
  document: vscode.TextDocument,
  position: vscode.Position,
): string {
  const prefixStart = new vscode.Position(Math.max(0, position.line - COMPLETION_PREFIX_LINES), 0);
  const suffixEndLine = Math.min(document.lineCount - 1, position.line + COMPLETION_SUFFIX_LINES);
  const suffixEnd = document.lineAt(suffixEndLine).range.end;
  const before = document.getText(new vscode.Range(prefixStart, position));
  const after = document.getText(new vscode.Range(position, suffixEnd));

  const lowerHandle = modelHandle.toLowerCase();
  if (lowerHandle.includes("deepseek") || lowerHandle.includes("qwen")) {
    return `<|fim_prefix|>${before}<|fim_hole|>${after}<|fim_suffix|>`;
  }

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
  context: vscode.ExtensionContext,
  modelHandle: string,
  state: CloudflareRequestState,
  systemPrompt: string,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const text = await requestCloudflareChatText(context, {
    modelHandle,
    state,
    messages: [
      {
        role: "system",
        content: systemPrompt,
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
  context: vscode.ExtensionContext,
  models: CloudflareModel[],
  accountId: string,
  apiKey: string,
  gatewayId?: string,
  preferredModelHandle?: string,
): vscode.Disposable | undefined {
  const completionModel = selectCloudflareCompletionModel(models, preferredModelHandle);
  if (!completionModel) {
    return undefined;
  }

  const completionModelHandle = getCloudflareModelHandle(completionModel);
  const completionSystemPrompt = getCompletionSystemPrompt();
  const excludedLanguageIds = getCompletionExcludedLanguages();
  const state: CloudflareRequestState = { accountId, apiKey, gatewayId };

  return vscode.languages.registerInlineCompletionItemProvider(
    { scheme: "file" },
    {
      async provideInlineCompletionItems(document, position, _context, token) {
        if (token.isCancellationRequested || position.line < 0) {
          return [];
        }

        if (excludedLanguageIds.has(document.languageId)) {
          return [];
        }

        const prompt = buildCompletionPrompt(completionModelHandle, document, position);
        const completionText = await fetchCompletion(
          context,
          completionModelHandle,
          state,
          completionSystemPrompt,
          prompt,
          token,
        );
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
