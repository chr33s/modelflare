import * as vscode from 'vscode';
import * as https from 'https';
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

function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

      const raw = await httpsPost(
        endpoint,
        {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body
      );

      let parsed: { result?: { response?: string }; response?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse Cloudflare response: ${raw}`);
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
