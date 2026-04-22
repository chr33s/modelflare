import * as vscode from "vscode";
import { enrichCloudflareModelsWithCapabilities, fetchCloudflareModels } from "./cloudflare-client";
import { registerModelProvider, RegisteredModelProvider } from "./model-provider";
import { registerCompletionProvider } from "./completion-provider";

const SECRET_KEY = "cloudflare-api-key";
const CLOUDLFARE_VENDOR = "cloudflare";

let providerRegistration: RegisteredModelProvider | undefined;
let completionRegistration: vscode.Disposable | undefined;
let inspectOutputChannel: vscode.OutputChannel | undefined;
let pendingModelLoad: Thenable<void> | undefined;

function normalizeApiKey(key: string): string {
  return key.trim().replace(/^Bearer\s+/i, "");
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  // Prefer secret storage over plain config
  const secret = await context.secrets.get(SECRET_KEY);
  if (secret) {
    return normalizeApiKey(secret);
  }
  const configuredKey = vscode.workspace
    .getConfiguration("cloudflareCopilot")
    .get<string>("apiKey");
  return configuredKey ? normalizeApiKey(configuredKey) : undefined;
}

function disposeProviderRegistration(): void {
  if (providerRegistration) {
    providerRegistration.dispose();
    providerRegistration = undefined;
  }
}

function disposeCompletionRegistration(): void {
  if (completionRegistration) {
    completionRegistration.dispose();
    completionRegistration = undefined;
  }
}

function getOutputChannel(): vscode.OutputChannel {
  if (!inspectOutputChannel) {
    inspectOutputChannel = vscode.window.createOutputChannel("Cloudflare Copilot Models");
  }

  return inspectOutputChannel;
}

function getNoModelsFoundMessage(modelFilter: string): string {
  if (modelFilter === "all") {
    return "Cloudflare returned no models for this account.";
  }

  return (
    `Cloudflare returned no models for the filter "${modelFilter}". ` +
    'Try setting "cloudflareCopilot.modelFilter" to "all" to inspect the models available to your account.'
  );
}

async function loadAndRegisterModels(context: vscode.ExtensionContext): Promise<void> {
  if (pendingModelLoad) {
    return pendingModelLoad;
  }

  const config = vscode.workspace.getConfiguration("cloudflareCopilot");
  const accountId = config.get<string>("accountId");
  const gatewayId = config.get<string>("gatewayId");
  const modelFilter = config.get<string>("modelFilter") ?? "Text Generation";
  const apiKey = await getApiKey(context);

  if (!accountId || !apiKey) {
    vscode.window
      .showWarningMessage(
        "Cloudflare Copilot Models: Please set your Account ID and API Key. " +
          'Use the "Cloudflare: Store API Key Securely" command for secure key storage.',
        "Open Settings",
      )
      .then((action: string | undefined) => {
        if (action === "Open Settings") {
          vscode.commands.executeCommand("workbench.action.openSettings", "cloudflareCopilot");
        }
      });
    return;
  }

  pendingModelLoad = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Cloudflare: Loading models...",
      cancellable: false,
    },
    async () => {
      try {
        const models = await fetchCloudflareModels(accountId, apiKey, modelFilter);
        const enrichedModels = await enrichCloudflareModelsWithCapabilities(
          accountId,
          apiKey,
          models,
        );

        if (enrichedModels.length === 0) {
          throw new Error(getNoModelsFoundMessage(modelFilter));
        }

        providerRegistration ??= registerModelProvider();
        providerRegistration.updateModels(enrichedModels, accountId, apiKey, gatewayId);
        disposeCompletionRegistration();
        completionRegistration = registerCompletionProvider(
          enrichedModels,
          accountId,
          apiKey,
          gatewayId,
        );

        vscode.window.showInformationMessage(
          `✅ Cloudflare: ${enrichedModels.length} model${enrichedModels.length !== 1 ? "s" : ""} registered in Copilot Chat`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Cloudflare Models: Failed to load — ${message}`);
      } finally {
        pendingModelLoad = undefined;
      }
    },
  );

  await pendingModelLoad;
}

function formatVisibleModel(model: vscode.LanguageModelChat): string {
  return `${model.name} (${model.id}) | family=${model.family} | version=${model.version} | maxInputTokens=${model.maxInputTokens}`;
}

function formatRegisteredModel(
  model: ReturnType<RegisteredModelProvider["getRegisteredModels"]>[number],
): string {
  const capabilityLabels = [
    model.capabilities.toolCalling ? "toolCalling" : undefined,
    model.capabilities.imageInput ? "imageInput" : undefined,
  ].filter((label): label is string => label !== undefined);

  const detail = model.detail ? ` | detail=${model.detail}` : "";
  const capabilities = capabilityLabels.length > 0 ? capabilityLabels.join(",") : "none";
  const isUserSelectable = ` | isUserSelectable=${model.isUserSelectable === true}`;
  const category = model.category?.label ? ` | category=${model.category.label}` : "";
  return `${model.name} (${model.id}) | capabilities=${capabilities}${isUserSelectable}${category}${detail}`;
}

async function inspectRegisteredModels(): Promise<void> {
  const outputChannel = getOutputChannel();
  const visibleModels = await vscode.lm.selectChatModels({ vendor: CLOUDLFARE_VENDOR });
  const registeredModels = providerRegistration?.getRegisteredModels() ?? [];
  const agentEligibleCount = registeredModels.filter(
    (model) =>
      model.capabilities.toolCalling === true || typeof model.capabilities.toolCalling === "number",
  ).length;

  outputChannel.clear();
  outputChannel.appendLine("Cloudflare model inspection");
  outputChannel.appendLine("");
  outputChannel.appendLine(`Registered in provider: ${registeredModels.length}`);
  outputChannel.appendLine(`Visible via vscode.lm.selectChatModels: ${visibleModels.length}`);
  outputChannel.appendLine(`Agent-mode eligible (toolCalling): ${agentEligibleCount}`);
  outputChannel.appendLine("");
  outputChannel.appendLine("Provider models:");

  if (registeredModels.length === 0) {
    outputChannel.appendLine("  (none)");
  } else {
    for (const model of registeredModels) {
      outputChannel.appendLine(`  - ${formatRegisteredModel(model)}`);
    }
  }

  outputChannel.appendLine("");
  outputChannel.appendLine("VS Code visible chat models:");

  if (visibleModels.length === 0) {
    outputChannel.appendLine("  (none)");
  } else {
    for (const model of visibleModels) {
      outputChannel.appendLine(`  - ${formatVisibleModel(model)}`);
    }
  }

  outputChannel.show(true);
  void vscode.window.showInformationMessage(
    `Cloudflare: provider has ${registeredModels.length} model${registeredModels.length !== 1 ? "s" : ""}; VS Code exposes ${visibleModels.length}`,
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  providerRegistration = registerModelProvider();

  // Command: Refresh models
  context.subscriptions.push(
    vscode.commands.registerCommand("cloudflareCopilot.refreshModels", async () => {
      await loadAndRegisterModels(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cloudflareCopilot.inspectModels", async () => {
      await inspectRegisteredModels();
    }),
  );

  // Command: Securely store API key
  context.subscriptions.push(
    vscode.commands.registerCommand("cloudflareCopilot.storeApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your Cloudflare API Key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "Bearer token from Cloudflare dashboard",
      });
      if (key) {
        const normalizedKey = normalizeApiKey(key);
        await context.secrets.store(SECRET_KEY, normalizedKey);
        vscode.window.showInformationMessage("✅ Cloudflare API Key stored securely.");
        await loadAndRegisterModels(context);
      }
    }),
  );

  // Ensure provider registration is disposed on deactivate without duplicating subscriptions on refresh.
  context.subscriptions.push(new vscode.Disposable(() => disposeProviderRegistration()));
  context.subscriptions.push(new vscode.Disposable(() => disposeCompletionRegistration()));
  context.subscriptions.push(new vscode.Disposable(() => inspectOutputChannel?.dispose()));

  // Auto-load on activation
  await loadAndRegisterModels(context);
}

export function deactivate(): void {
  disposeProviderRegistration();
  disposeCompletionRegistration();
}
