import * as vscode from 'vscode';
import { CloudflareModel } from './cloudflareClient';

interface ProviderModelInformation extends vscode.LanguageModelChatInformation {
  cloudflareModel: CloudflareModel;
}

function buildEndpoint(model: CloudflareModel, accountId: string, gatewayId?: string): string {
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${model.id}`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`;
}

function getMessageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map(part => part.value)
    .join('');
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return 'user';
  }

  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }

  return 'system';
}

export function registerModelProvider(
  models: CloudflareModel[],
  accountId: string,
  apiKey: string,
  gatewayId?: string
): vscode.Disposable {
  const modelInfos: ProviderModelInformation[] = models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    family: model.id,
    version: '1.0',
    maxInputTokens: 8192,
    maxOutputTokens: 4096,
    capabilities: {},
    tooltip: model.description,
    cloudflareModel: model
  }));

  const provider: vscode.LanguageModelChatProvider<ProviderModelInformation> = {
    provideLanguageModelChatInformation(): ProviderModelInformation[] {
      return modelInfos;
    },

    async provideTokenCount(_model, text): Promise<number> {
      const sourceText = typeof text === 'string' ? text : getMessageText(text);
      return Math.ceil(sourceText.length / 4);
    },

    async provideLanguageModelChatResponse(
      model,
      messages,
      _options,
      progress,
      token
    ): Promise<void> {
      if (token.isCancellationRequested) {
        return;
      }

      const endpoint = buildEndpoint(model.cloudflareModel, accountId, gatewayId);
      const formattedMessages = messages.map((message) => ({
        role: mapRole(message.role),
        content: getMessageText(message)
      }));

      const body = JSON.stringify({ messages: formattedMessages });
      const abortController = new AbortController();
      const cancellationDisposable = token.onCancellationRequested(() => abortController.abort());
      let raw = '';

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body,
          signal: abortController.signal
        });

        raw = await response.text();
        if (!response.ok) {
          throw new Error(`Cloudflare model request failed (${response.status}): ${raw}`);
        }
      } finally {
        cancellationDisposable.dispose();
      }

      let parsed: { result?: { response?: string }; response?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        throw new Error(`Failed to parse Cloudflare response (${message}): ${raw}`);
      }

      if (token.isCancellationRequested) {
        return;
      }

      const text = parsed?.result?.response ?? parsed?.response ?? '';
      if (text) {
        progress.report(new vscode.LanguageModelTextPart(text));
      }
    }
  };

  return vscode.lm.registerLanguageModelChatProvider('cloudflare', provider);
}
