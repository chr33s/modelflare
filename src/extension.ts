import * as vscode from "vscode";
import { enrichCloudflareModelsWithCapabilities, fetchCloudflareModels } from "./cloudflare-client";
import { registerModelProvider, RegisteredModelProvider } from "./model-provider";
import { registerCompletionProvider } from "./completion-provider";
import { loadCachedCloudflareModels, saveCachedCloudflareModels } from "./model-cache";
import {
  getRecentCloudflareRequestMetrics,
  AggregatedCloudflareRequestMetric,
  RecordedCloudflareRequestMetric,
  summarizeCloudflareRequestMetrics,
  loadCloudflareRequestMetrics,
} from "./request-metrics";

const SECRET_KEY = "cloudflare-api-key";
const VENDOR = "cloudflare";
const MODEL_RELOAD_DEBOUNCE_MS = 300;

let providerRegistration: RegisteredModelProvider | undefined;
let completionRegistration: vscode.Disposable | undefined;
let inspectOutputChannel: vscode.OutputChannel | undefined;
let pendingModelLoad: Thenable<void> | undefined;
let pendingReloadTimer: ReturnType<typeof setTimeout> | undefined;
let queuedModelReload:
  | {
      context: vscode.ExtensionContext;
      options: LoadModelsOptions;
    }
  | undefined;

export type ModelLoadCachePolicy = "prefer-cache" | "refresh";

export interface LoadModelsOptions {
  readonly notifyOnMissingConfiguration: boolean;
  readonly notifyOnSuccess: boolean;
  readonly notifyOnError: boolean;
  readonly cachePolicy: ModelLoadCachePolicy;
}

const INTERACTIVE_LOAD_OPTIONS: LoadModelsOptions = {
  notifyOnMissingConfiguration: true,
  notifyOnSuccess: true,
  notifyOnError: true,
  cachePolicy: "prefer-cache",
};

const AUTOMATIC_LOAD_OPTIONS: LoadModelsOptions = {
  notifyOnMissingConfiguration: false,
  notifyOnSuccess: false,
  notifyOnError: false,
  cachePolicy: "prefer-cache",
};

const MANUAL_REFRESH_LOAD_OPTIONS: LoadModelsOptions = {
  notifyOnMissingConfiguration: true,
  notifyOnSuccess: true,
  notifyOnError: true,
  cachePolicy: "refresh",
};

export function normalizeApiKey(key: string): string {
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

function clearRegisteredModels(): void {
  providerRegistration?.clearModels();
  disposeCompletionRegistration();
}

function registerLoadedModels(
  context: vscode.ExtensionContext,
  models: Parameters<RegisteredModelProvider["updateModels"]>[0],
  accountId: string,
  apiKey: string,
  gatewayId: string | undefined,
  completionModel: string | undefined,
): void {
  providerRegistration ??= registerModelProvider(context);
  providerRegistration.updateModels(models, accountId, apiKey, gatewayId);
  disposeCompletionRegistration();
  completionRegistration = registerCompletionProvider(
    context,
    models,
    accountId,
    apiKey,
    gatewayId,
    completionModel,
  );
}

function disposePendingReload(): void {
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
    pendingReloadTimer = undefined;
  }
}

function disposeInspectOutputChannel(): void {
  if (inspectOutputChannel) {
    inspectOutputChannel.dispose();
    inspectOutputChannel = undefined;
  }
}

function disposeExtensionState(): void {
  disposeProviderRegistration();
  disposeCompletionRegistration();
  disposeInspectOutputChannel();
  disposePendingReload();
}

function getOutputChannel(): vscode.OutputChannel {
  if (!inspectOutputChannel) {
    inspectOutputChannel = vscode.window.createOutputChannel("Cloudflare Copilot Models");
  }

  return inspectOutputChannel;
}

export function getNoModelsFoundMessage(modelFilter: string): string {
  if (modelFilter === "all") {
    return "Cloudflare returned no models for this account.";
  }

  return (
    `Cloudflare returned no models for the filter "${modelFilter}". ` +
    'Try setting "cloudflareCopilot.modelFilter" to "all" to inspect the models available to your account.'
  );
}

function getModelLoadSuccessMessage(modelCount: number, options: LoadModelsOptions): string {
  const suffix = modelCount === 1 ? "" : "s";

  if (options.cachePolicy === "refresh") {
    return `✅ Cloudflare: ${modelCount} model${suffix} refreshed in Copilot Chat`;
  }

  return `✅ Cloudflare: ${modelCount} model${suffix} registered in Copilot Chat`;
}

export async function synchronizeCloudflareModelPicker(
  selectChatModels: typeof vscode.lm.selectChatModels = (selector) =>
    vscode.lm.selectChatModels(selector),
  onError: (message: string, error: unknown) => void = (message, error) => {
    console.warn(message, error);
  },
): Promise<void> {
  try {
    await selectChatModels({ vendor: VENDOR });
  } catch (error) {
    onError("Failed to synchronize Cloudflare model picker", error);
  }
}

export function shouldReloadForConfigurationChange(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration("cloudflareCopilot");
}

export function shouldReloadForSecretChange(event: vscode.SecretStorageChangeEvent): boolean {
  return event.key === SECRET_KEY;
}

function scheduleModelReload(
  context: vscode.ExtensionContext,
  options: LoadModelsOptions = AUTOMATIC_LOAD_OPTIONS,
): void {
  disposePendingReload();
  pendingReloadTimer = setTimeout(() => {
    pendingReloadTimer = undefined;
    void loadAndRegisterModels(context, options);
  }, MODEL_RELOAD_DEBOUNCE_MS);
}

export function mergeLoadModelsOptions(
  current: LoadModelsOptions,
  incoming: LoadModelsOptions,
): LoadModelsOptions {
  return {
    notifyOnMissingConfiguration:
      current.notifyOnMissingConfiguration || incoming.notifyOnMissingConfiguration,
    notifyOnSuccess: current.notifyOnSuccess || incoming.notifyOnSuccess,
    notifyOnError: current.notifyOnError || incoming.notifyOnError,
    cachePolicy:
      current.cachePolicy === "refresh" || incoming.cachePolicy === "refresh"
        ? "refresh"
        : "prefer-cache",
  };
}

function queueModelReload(context: vscode.ExtensionContext, options: LoadModelsOptions): void {
  queuedModelReload = queuedModelReload
    ? {
        context,
        options: mergeLoadModelsOptions(queuedModelReload.options, options),
      }
    : { context, options };
}

async function performModelLoad(
  context: vscode.ExtensionContext,
  options: LoadModelsOptions,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("cloudflareCopilot");
  const accountId = config.get<string>("accountId");
  const gatewayId = config.get<string>("gatewayId");
  const modelFilter = config.get<string>("modelFilter") ?? "Text Generation";
  const completionModel = config.get<string>("completionModel");
  const capabilityOverrides = config.get<Record<string, any>>("capabilityOverrides") ?? {};
  const apiKey = await getApiKey(context);

  if (!accountId || !apiKey) {
    clearRegisteredModels();
    await synchronizeCloudflareModelPicker();
    if (options.notifyOnMissingConfiguration) {
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
    }
    return;
  }

  try {
    const cacheQuery = {
      accountId,
      apiKey,
      modelFilter,
      capabilityOverrides,
    };
    const cachedModels =
      options.cachePolicy === "prefer-cache"
        ? loadCachedCloudflareModels(context, cacheQuery)
        : undefined;

    if (cachedModels && cachedModels.models.length > 0) {
      registerLoadedModels(
        context,
        cachedModels.models,
        accountId,
        apiKey,
        gatewayId,
        completionModel,
      );

      await synchronizeCloudflareModelPicker();

      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Cloudflare: Loading models...",
        cancellable: false,
      },
      async () => {
        const models = await fetchCloudflareModels(accountId, apiKey, modelFilter);
        const enrichedModels = await enrichCloudflareModelsWithCapabilities(
          accountId,
          apiKey,
          models,
          capabilityOverrides,
        );

        if (enrichedModels.length === 0) {
          throw new Error(getNoModelsFoundMessage(modelFilter));
        }

        registerLoadedModels(
          context,
          enrichedModels,
          accountId,
          apiKey,
          gatewayId,
          completionModel,
        );
        saveCachedCloudflareModels(context, cacheQuery, enrichedModels);
        await synchronizeCloudflareModelPicker();

        if (options.notifyOnSuccess) {
          vscode.window.showInformationMessage(
            getModelLoadSuccessMessage(enrichedModels.length, options),
          );
        }
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.notifyOnError) {
      vscode.window.showErrorMessage(`Cloudflare Models: Failed to load — ${message}`);
    }
  }
}

async function loadAndRegisterModels(
  context: vscode.ExtensionContext,
  options: LoadModelsOptions = INTERACTIVE_LOAD_OPTIONS,
): Promise<void> {
  if (pendingModelLoad) {
    queueModelReload(context, options);
    return pendingModelLoad;
  }

  pendingModelLoad = (async () => {
    let nextModelReload:
      | {
          context: vscode.ExtensionContext;
          options: LoadModelsOptions;
        }
      | undefined = { context, options };

    try {
      while (nextModelReload) {
        queuedModelReload = undefined;
        await performModelLoad(nextModelReload.context, nextModelReload.options);
        nextModelReload = queuedModelReload;
      }
    } finally {
      pendingModelLoad = undefined;
      queuedModelReload = undefined;
    }
  })();

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

function formatUsageSummary(metric: RecordedCloudflareRequestMetric): string {
  if (!metric.usage) {
    return "";
  }

  const parts = [
    typeof metric.usage.totalTokens === "number" ? `total=${metric.usage.totalTokens}` : undefined,
    typeof metric.usage.promptTokens === "number"
      ? `prompt=${metric.usage.promptTokens}`
      : undefined,
    typeof metric.usage.completionTokens === "number"
      ? `completion=${metric.usage.completionTokens}`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? ` | usage=${parts.join(",")}` : "";
}

function normalizeMetricErrorMessage(message: string, maxLength = 180): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatErrorSummary(metric: RecordedCloudflareRequestMetric): string {
  if (metric.outcome !== "error") {
    return "";
  }

  const status = typeof metric.errorStatus === "number" ? ` | status=${metric.errorStatus}` : "";
  const errorMessage =
    metric.errorMessage && metric.errorMessage.length > 0
      ? ` | error=${normalizeMetricErrorMessage(metric.errorMessage)}`
      : "";

  return `${status}${errorMessage}`;
}

function formatLatestFailureSummary(summary: AggregatedCloudflareRequestMetric): string {
  if (!summary.latestFailure) {
    return " | latestFailure=none";
  }

  const status =
    typeof summary.latestFailure.status === "number"
      ? ` status=${summary.latestFailure.status}`
      : "";
  const errorMessage =
    summary.latestFailure.message && summary.latestFailure.message.length > 0
      ? ` error=${normalizeMetricErrorMessage(summary.latestFailure.message, 120)}`
      : "";

  return (
    ` | latestFailure=${new Date(summary.latestFailure.recordedAt).toISOString()}` +
    ` request=${summary.latestFailure.requestKind}${status}${errorMessage}`
  );
}

function formatAverageMs(value: number | undefined): string {
  if (typeof value !== "number") {
    return "n/a";
  }

  return `${Math.round(value)}ms`;
}

function formatRate(value: number): string {
  const percentage = value * 100;
  const rounded = Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1);
  return `${rounded}%`;
}

export function formatRecordedRequestMetric(metric: RecordedCloudflareRequestMetric): string {
  const ttft =
    typeof metric.timeToFirstTextMs === "number" ? `${metric.timeToFirstTextMs}ms` : "n/a";
  const fallback = metric.gatewayFallbackToDirect ? " | fallback=gateway->direct" : "";
  return (
    `${new Date(metric.recordedAt).toISOString()} | account=${metric.accountId}` +
    ` | ${metric.requestKind} ${metric.modelHandle}` +
    ` | outcome=${metric.outcome}` +
    ` | transport=${metric.endpointKind}/${metric.deliveryMode}` +
    ` | requestedStream=${metric.requestedStream}` +
    ` | total=${metric.totalDurationMs}ms | ttft=${ttft}` +
    `${fallback}${formatUsageSummary(metric)}${formatErrorSummary(metric)}`
  );
}

export function formatRequestMetricSummary(summary: AggregatedCloudflareRequestMetric): string {
  return (
    `account=${summary.accountId} | ${summary.modelHandle} | total=${summary.totalCount}` +
    ` success=${summary.successCount} error=${summary.errorCount} cancelled=${summary.cancelledCount}` +
    ` | avgDuration=${formatAverageMs(summary.averageTotalDurationMs)}` +
    ` avgTtft=${formatAverageMs(summary.averageTimeToFirstTextMs)}` +
    ` errorRate=${formatRate(summary.errorRate)}` +
    `${formatLatestFailureSummary(summary)}`
  );
}

async function inspectRegisteredModels(): Promise<void> {
  const outputChannel = getOutputChannel();
  const visibleModels = await vscode.lm.selectChatModels({ vendor: VENDOR });
  const registeredModels = providerRegistration?.getRegisteredModels() ?? [];
  const recentRequestMetrics = getRecentCloudflareRequestMetrics();
  const requestSummaries = summarizeCloudflareRequestMetrics(recentRequestMetrics);
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

  outputChannel.appendLine("");
  outputChannel.appendLine(`Recent request summary by model: ${requestSummaries.length}`);

  if (requestSummaries.length === 0) {
    outputChannel.appendLine("  (none recorded yet)");
  } else {
    for (const summary of requestSummaries) {
      outputChannel.appendLine(`  - ${formatRequestMetricSummary(summary)}`);
    }
  }

  outputChannel.appendLine("");
  outputChannel.appendLine(`Recent Cloudflare requests: ${recentRequestMetrics.length}`);

  if (recentRequestMetrics.length === 0) {
    outputChannel.appendLine("  (none recorded yet)");
  } else {
    for (const metric of recentRequestMetrics) {
      outputChannel.appendLine(`  - ${formatRecordedRequestMetric(metric)}`);
    }
  }

  outputChannel.show(true);
  void vscode.window.showInformationMessage(
    `Cloudflare: provider has ${registeredModels.length} model${registeredModels.length !== 1 ? "s" : ""}; VS Code exposes ${visibleModels.length}`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  loadCloudflareRequestMetrics(context);
  providerRegistration = registerModelProvider(context);

  // Command: Refresh models
  context.subscriptions.push(
    vscode.commands.registerCommand("cloudflareCopilot.refreshModels", async () => {
      await loadAndRegisterModels(context, MANUAL_REFRESH_LOAD_OPTIONS);
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
        await loadAndRegisterModels(context, INTERACTIVE_LOAD_OPTIONS);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (shouldReloadForConfigurationChange(event)) {
        scheduleModelReload(context);
      }
    }),
  );

  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (shouldReloadForSecretChange(event)) {
        scheduleModelReload(context);
      }
    }),
  );

  // Auto-load on activation
  void loadAndRegisterModels(context, INTERACTIVE_LOAD_OPTIONS);
}

export function deactivate(): void {
  disposeExtensionState();
}
