import * as vscode from 'vscode';
import { CloudflareModel } from './cloudflareClient';

const COMPLETION_PREFIX_LINES = 120;
const COMPLETION_SUFFIX_LINES = 40;
const NON_CODE_LANGUAGE_IDS = new Set(['plaintext', 'markdown', 'json', 'jsonc', 'log']);

function buildEndpoint(model: CloudflareModel, accountId: string, gatewayId?: string): string {
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${model.id}`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`;
}

function buildCompletionPrompt(document: vscode.TextDocument, position: vscode.Position): string {
  const prefixStart = new vscode.Position(Math.max(0, position.line - COMPLETION_PREFIX_LINES), 0);
  const suffixEndLine = Math.min(document.lineCount - 1, position.line + COMPLETION_SUFFIX_LINES);
  const suffixEnd = document.lineAt(suffixEndLine).range.end;
  const before = document.getText(new vscode.Range(prefixStart, position));
  const after = document.getText(new vscode.Range(position, suffixEnd));

  return [
    'Complete the code at <cursor>.',
    'Return only completion text that should be inserted at the cursor.',
    '',
    '<before>',
    before,
    '</before>',
    '<cursor />',
    '<after>',
    after,
    '</after>'
  ].join('\n');
}

async function fetchCompletion(
  model: CloudflareModel,
  accountId: string,
  apiKey: string,
  prompt: string,
  token: vscode.CancellationToken,
  gatewayId?: string
): Promise<string> {
  const endpoint = buildEndpoint(model, accountId, gatewayId);
  const abortController = new AbortController();
  const cancellationDisposable = token.onCancellationRequested(() => abortController.abort());

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'You are a precise code completion engine. Return only the completion with no markdown or explanation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      }),
      signal: abortController.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Cloudflare completion request failed (${response.status}): ${raw}`);
    }

    // Cloudflare Workers AI responses may be wrapped as result.response or returned as response.
    const parsed = JSON.parse(raw) as { result?: { response?: string }; response?: string };
    return (parsed?.result?.response ?? parsed?.response ?? '').trimEnd();
  } catch (error) {
    if (token.isCancellationRequested && error instanceof DOMException && error.name === 'AbortError') {
      return '';
    }

    throw error;
  } finally {
    cancellationDisposable.dispose();
  }
}

export function registerCompletionProvider(
  models: CloudflareModel[],
  accountId: string,
  apiKey: string,
  gatewayId?: string
): vscode.Disposable | undefined {
  const completionModel = models.find((model) => model.task?.id === 'text-generation');
  if (!completionModel) {
    return undefined;
  }

  return vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, {
    async provideInlineCompletionItems(document, position, _context, token) {
      if (token.isCancellationRequested || position.line < 0) {
        return [];
      }

      if (NON_CODE_LANGUAGE_IDS.has(document.languageId)) {
        return [];
      }

      const prompt = buildCompletionPrompt(document, position);
      const completionText = await fetchCompletion(completionModel, accountId, apiKey, prompt, token, gatewayId);
      if (!completionText || token.isCancellationRequested) {
        return [];
      }

      return [new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position))];
    }
  });
}
