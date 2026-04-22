import * as vscode from 'vscode';
import { fetchCloudflareModels } from './cloudflareClient';
import { registerModelProvider } from './modelProvider';

const SECRET_KEY = 'cloudflare-api-key';
let providerRegistration: vscode.Disposable | undefined;

function normalizeApiKey(key: string): string {
  return key.trim().replace(/^Bearer\s+/i, '');
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Prefer secret storage over plain config
  const secret = await context.secrets.get(SECRET_KEY);
  if (secret) {
    return normalizeApiKey(secret);
  }
  const configuredKey = vscode.workspace.getConfiguration('cloudflareCopilot').get<string>('apiKey');
  return configuredKey ? normalizeApiKey(configuredKey) : undefined;
}

function disposeProviderRegistration(): void {
  if (providerRegistration) {
    providerRegistration.dispose();
    providerRegistration = undefined;
  }
}

async function loadAndRegisterModels(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cloudflareCopilot');
  const accountId = config.get<string>('accountId');
  const gatewayId = config.get<string>('gatewayId');
  const modelFilter = config.get<string>('modelFilter') ?? 'text-generation';
  const apiKey = await getApiKey(context);

  if (!accountId || !apiKey) {
    vscode.window
      .showWarningMessage(
        'Cloudflare Copilot Models: Please set your Account ID and API Key. ' +
          'Use the "Cloudflare: Store API Key Securely" command for secure key storage.',
        'Open Settings'
      )
      .then((action: string | undefined) => {
        if (action === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'cloudflareCopilot');
        }
      });
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cloudflare: Loading models...',
      cancellable: false
    },
    async () => {
      try {
        const models = await fetchCloudflareModels(accountId, apiKey, modelFilter);

        disposeProviderRegistration();
        providerRegistration = registerModelProvider(models, accountId, apiKey, gatewayId);

        vscode.window.showInformationMessage(
          `✅ Cloudflare: ${models.length} model${models.length !== 1 ? 's' : ''} registered in Copilot Chat`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Cloudflare Models: Failed to load — ${message}`);
      }
    }
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Command: Refresh models
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudflareCopilot.refreshModels', async () => {
      await loadAndRegisterModels(context);
    })
  );

  // Command: Securely store API key
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudflareCopilot.storeApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Cloudflare API Key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Bearer token from Cloudflare dashboard'
      });
      if (key) {
        const normalizedKey = normalizeApiKey(key);
        await context.secrets.store(SECRET_KEY, normalizedKey);
        vscode.window.showInformationMessage('✅ Cloudflare API Key stored securely.');
        await loadAndRegisterModels(context);
      }
    })
  );

  // Ensure provider registration is disposed on deactivate without duplicating subscriptions on refresh.
  context.subscriptions.push(new vscode.Disposable(() => disposeProviderRegistration()));

  // Auto-load on activation
  await loadAndRegisterModels(context);
}

export function deactivate(): void {
  disposeProviderRegistration();
}
