import * as vscode from "vscode";
import {
  CloudflareModel,
  CloudflareModelSource,
  enrichCloudflareModelsWithCapabilities,
  fetchCloudflareAiGatewayModels,
  fetchCloudflareModels,
  getCloudflareModelHandle,
  getCloudflareModelPickerCategory,
  parseManualCloudflareModels,
} from "./cloudflare-client";
import { getModelflareConfiguration } from "./config";
import { registerModelProvider, RegisteredModelProvider } from "./model-provider";
import { registerCompletionProvider } from "./completion-provider";
import { loadCachedCloudflareModels, saveCachedCloudflareModels } from "./model-cache";
import {
  appendCloudflareLogLine,
  clearCloudflareOutputChannel,
  disposeCloudflareOutputChannel,
  logCloudflareWarning,
  showCloudflareOutputChannel,
} from "./logging";
import {
  getRecentCloudflareRequestMetrics,
  AggregatedCloudflareRequestMetric,
  RecordedCloudflareRequestMetric,
  summarizeCloudflareRequestMetrics,
  loadCloudflareRequestMetrics,
} from "./request-metrics";
import { LANGUAGE_MODEL_VENDOR } from "./provider-identity";
import { formatUnknownErrorMessage } from "./value-utils";

const SECRET_KEY = "cloudflare-api-key";
const VENDOR = LANGUAGE_MODEL_VENDOR;
const MODEL_RELOAD_DEBOUNCE_MS = 300;

let providerRegistration: RegisteredModelProvider | undefined;
let completionRegistration: vscode.Disposable | undefined;
let pendingModelLoad: Thenable<void> | undefined;
let pendingReloadTimer: ReturnType<typeof setTimeout> | undefined;
let lastModelLoadDiagnostics: CloudflareModelLoadDiagnostics | undefined;
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

interface CloudflareModelSourceCounts {
  "workers-ai": number;
  "ai-gateway": number;
  manual: number;
}

interface CloudflareModelLoadDiagnostics {
  loadedAt: number;
  cachePolicy: ModelLoadCachePolicy;
  loadedFromCache: boolean;
  modelFilter: string;
  gatewayId?: string;
  includeGatewaySupportedModels: boolean;
  gatewaySupportedModelProviders: readonly string[];
  configuredManualModels: number;
  discoveredCounts: CloudflareModelSourceCounts;
  registeredCounts: CloudflareModelSourceCounts;
  duplicateHandles: readonly string[];
  warnings: readonly string[];
}

interface CloudflareModelDiscoveryResult {
  models: CloudflareModel[];
  error?: unknown;
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
  const configuredKey = getModelflareConfiguration().apiKey;
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
  providerRegistration ??= registerModelProvider(context).provider;
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

function disposeExtensionState(): void {
  disposeProviderRegistration();
  disposeCompletionRegistration();
  disposeCloudflareOutputChannel();
  disposePendingReload();
}

function createEmptyCloudflareModelSourceCounts(): CloudflareModelSourceCounts {
  return {
    "workers-ai": 0,
    "ai-gateway": 0,
    manual: 0,
  };
}

export function countCloudflareModelsBySource(
  models: readonly Pick<CloudflareModel, "source">[],
): CloudflareModelSourceCounts {
  return models.reduce<CloudflareModelSourceCounts>((counts, model) => {
    const source = (model.source ?? "workers-ai") as CloudflareModelSource;
    if (source in counts) {
      counts[source] += 1;
    }
    return counts;
  }, createEmptyCloudflareModelSourceCounts());
}

function formatCloudflareModelSource(source: CloudflareModelSource | undefined): string {
  switch (source) {
    case "ai-gateway":
      return "AI Gateway";
    case "manual":
      return "Manual";
    case "workers-ai":
    default:
      return "Workers AI";
  }
}

function formatCloudflareModelTransport(
  transport: CloudflareModel["transport"] | undefined,
): string {
  switch (transport) {
    case "compat":
      return "compat";
    case "direct":
      return "direct";
    default:
      return "unknown";
  }
}

function mergeCloudflareModelCatalogs(modelGroups: readonly CloudflareModel[][]): {
  models: CloudflareModel[];
  duplicateHandles: string[];
} {
  const mergedModels = new Map<string, CloudflareModel>();
  const duplicateHandles = new Set<string>();

  for (const group of modelGroups) {
    for (const model of group) {
      const modelHandle = getCloudflareModelHandle(model);
      if (mergedModels.has(modelHandle)) {
        duplicateHandles.add(modelHandle);
      }
      mergedModels.set(modelHandle, model);
    }
  }

  return {
    models: [...mergedModels.values()],
    duplicateHandles: [...duplicateHandles].sort((left, right) => left.localeCompare(right)),
  };
}

export function diffCloudflareModelIds(
  registeredModelIds: readonly string[],
  visibleModelIds: readonly string[],
): {
  registeredOnly: string[];
  visibleOnly: string[];
} {
  const registeredIdSet = new Set(registeredModelIds);
  const visibleIdSet = new Set(visibleModelIds);

  return {
    registeredOnly: [...registeredIdSet].filter((modelId) => !visibleIdSet.has(modelId)).sort(),
    visibleOnly: [...visibleIdSet].filter((modelId) => !registeredIdSet.has(modelId)).sort(),
  };
}

function describeGatewaySelection(gatewayId: string | undefined): string {
  const normalizedGatewayId = gatewayId?.trim();
  return normalizedGatewayId && normalizedGatewayId.length > 0
    ? normalizedGatewayId
    : "default compat / direct Workers AI";
}

export function getNoModelsFoundMessage(modelFilter: string): string {
  if (modelFilter === "all") {
    return "Cloudflare returned no models for this account.";
  }

  return (
    `Cloudflare returned no models for the filter "${modelFilter}". ` +
    'Try setting "modelflare.modelFilter" to "all" to inspect the models available to your account.'
  );
}

function getModelLoadSuccessMessage(modelCount: number, options: LoadModelsOptions): string {
  const suffix = modelCount === 1 ? "" : "s";

  if (options.cachePolicy === "refresh") {
    return `Modelflare: ${modelCount} model${suffix} refreshed in Copilot Chat`;
  }

  return `Modelflare: ${modelCount} model${suffix} registered in Copilot Chat`;
}

export async function synchronizeCloudflareModelPicker(
  selectChatModels: typeof vscode.lm.selectChatModels = (selector) =>
    vscode.lm.selectChatModels(selector),
  onError: (message: string, error: unknown) => void = logCloudflareWarning,
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
  return event.affectsConfiguration("modelflare");
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
  const config = getModelflareConfiguration();
  const accountId = config.accountId;
  const gatewayId = config.gatewayId;
  const modelFilter = config.modelFilter;
  const includeGatewaySupportedModels = config.includeGatewaySupportedModels;
  const gatewaySupportedModelProviders = [...config.gatewaySupportedModelProviders];
  const manualModelEntries = [...config.manualModels];
  const completionModel = config.completionModel;
  const capabilityOverrides = config.capabilityOverrides;
  const parsedManualModels = parseManualCloudflareModels(manualModelEntries);
  const apiKey = await getApiKey(context);

  if (!accountId || !apiKey) {
    lastModelLoadDiagnostics = undefined;
    clearRegisteredModels();
    await synchronizeCloudflareModelPicker();
    if (options.notifyOnMissingConfiguration) {
      vscode.window
        .showWarningMessage(
          "Modelflare: Please set your Cloudflare Account ID and API Key. " +
            'Use the "Modelflare: Store Credentials" command for secure key storage.',
          "Open Settings",
        )
        .then((action: string | undefined) => {
          if (action === "Open Settings") {
            vscode.commands.executeCommand("workbench.action.openSettings", "modelflare");
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
      includeGatewaySupportedModels,
      gatewaySupportedModelProviders,
      manualModels: manualModelEntries,
      capabilityOverrides,
    };
    const cachedModels =
      options.cachePolicy === "prefer-cache"
        ? loadCachedCloudflareModels(context, cacheQuery)
        : undefined;

    if (cachedModels && cachedModels.models.length > 0) {
      const cachedSourceCounts = countCloudflareModelsBySource(cachedModels.models);
      lastModelLoadDiagnostics = {
        loadedAt: cachedModels.cachedAt,
        cachePolicy: options.cachePolicy,
        loadedFromCache: true,
        modelFilter,
        gatewayId,
        includeGatewaySupportedModels,
        gatewaySupportedModelProviders,
        configuredManualModels: manualModelEntries.length,
        discoveredCounts: cachedSourceCounts,
        registeredCounts: cachedSourceCounts,
        duplicateHandles: [],
        warnings:
          parsedManualModels.warnings.length > 0
            ? [
                ...parsedManualModels.warnings,
                "Loaded from cache; refresh to inspect the latest upstream discovery results.",
              ]
            : ["Loaded from cache; refresh to inspect the latest upstream discovery results."],
      };
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
        title: "Modelflare: Loading models...",
        cancellable: true,
      },
      async (_progress, token) => {
        if (token.isCancellationRequested) {
          return;
        }

        const abortController = new AbortController();
        const cancellationDisposable = token.onCancellationRequested(() => {
          abortController.abort(new DOMException("The user aborted model loading.", "AbortError"));
        });

        try {
          const discoveryWarnings = [...parsedManualModels.warnings];
          const [workersAiResult, gatewayResult]: [
            CloudflareModelDiscoveryResult,
            CloudflareModelDiscoveryResult,
          ] = await Promise.all([
            fetchCloudflareModels(accountId, apiKey, modelFilter, abortController.signal)
              .then((models): CloudflareModelDiscoveryResult => ({ models, error: undefined }))
              .catch((error: unknown) => ({
                models: [] as CloudflareModel[],
                error,
              })),
            includeGatewaySupportedModels
              ? fetchCloudflareAiGatewayModels(
                  modelFilter,
                  gatewaySupportedModelProviders,
                  abortController.signal,
                )
                  .then((models): CloudflareModelDiscoveryResult => ({ models, error: undefined }))
                  .catch((error: unknown) => ({
                    models: [] as CloudflareModel[],
                    error,
                  }))
              : Promise.resolve<CloudflareModelDiscoveryResult>({
                  models: [] as CloudflareModel[],
                  error: undefined,
                }),
          ]);

          if (token.isCancellationRequested) {
            return;
          }

          if (workersAiResult.error) {
            const message = formatUnknownErrorMessage(workersAiResult.error);
            discoveryWarnings.push(`Workers AI discovery failed: ${message}`);
          }

          if (gatewayResult.error) {
            const message = formatUnknownErrorMessage(gatewayResult.error);
            discoveryWarnings.push(`AI Gateway discovery failed: ${message}`);
          }

          if (
            includeGatewaySupportedModels &&
            !gatewayResult.error &&
            gatewayResult.models.length === 0
          ) {
            discoveryWarnings.push(
              "AI Gateway supported-models catalog returned zero models — " +
                "Cloudflare may have changed the page format.",
            );
          }

          const discoveredCounts = createEmptyCloudflareModelSourceCounts();
          discoveredCounts["workers-ai"] = workersAiResult.models.length;
          discoveredCounts["ai-gateway"] = gatewayResult.models.length;
          discoveredCounts.manual = parsedManualModels.models.length;

          const mergedModels = mergeCloudflareModelCatalogs([
            workersAiResult.models,
            gatewayResult.models,
            parsedManualModels.models,
          ]);
          const enrichedModels = await enrichCloudflareModelsWithCapabilities(
            accountId,
            apiKey,
            mergedModels.models,
            capabilityOverrides,
            abortController.signal,
          ).catch((error) => {
            if (abortController.signal.aborted) {
              return undefined;
            }

            throw error;
          });

          if (token.isCancellationRequested || !enrichedModels) {
            return;
          }

          lastModelLoadDiagnostics = {
            loadedAt: Date.now(),
            cachePolicy: options.cachePolicy,
            loadedFromCache: false,
            modelFilter,
            gatewayId,
            includeGatewaySupportedModels,
            gatewaySupportedModelProviders,
            configuredManualModels: manualModelEntries.length,
            discoveredCounts,
            registeredCounts: countCloudflareModelsBySource(enrichedModels),
            duplicateHandles: mergedModels.duplicateHandles,
            warnings: discoveryWarnings,
          };

          if (enrichedModels.length === 0) {
            const warningsSuffix =
              discoveryWarnings.length > 0 ? ` ${discoveryWarnings.join(" ")}` : "";
            throw new Error(`${getNoModelsFoundMessage(modelFilter)}${warningsSuffix}`);
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
        } finally {
          cancellationDisposable.dispose();
        }
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (options.notifyOnError) {
      vscode.window.showErrorMessage(`Modelflare: Failed to load — ${message}`);
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
  cloudflareModel?: CloudflareModel,
): string {
  const capabilityLabels = [
    model.capabilities.toolCalling ? "toolCalling" : undefined,
    model.capabilities.imageInput ? "imageInput" : undefined,
  ].filter((label): label is string => label !== undefined);

  const detail = model.detail ? ` | detail=${model.detail}` : "";
  const capabilities = capabilityLabels.length > 0 ? capabilityLabels.join(",") : "none";
  const isUserSelectable = ` | isUserSelectable=${model.isUserSelectable === true}`;
  const categoryLabel = cloudflareModel
    ? getCloudflareModelPickerCategory(cloudflareModel).label
    : undefined;
  const category = categoryLabel ? ` | category=${categoryLabel}` : "";
  const source = cloudflareModel?.source
    ? ` | source=${formatCloudflareModelSource(cloudflareModel.source)}`
    : "";
  const transport = cloudflareModel?.transport
    ? ` | transport=${formatCloudflareModelTransport(cloudflareModel.transport)}`
    : "";
  const task = cloudflareModel?.task?.name ? ` | task=${cloudflareModel.task.name}` : "";
  return (
    `${model.name} (${model.id}) | capabilities=${capabilities}${isUserSelectable}` +
    `${category}${source}${transport}${task}${detail}`
  );
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
  const visibleModels = await vscode.lm.selectChatModels({ vendor: VENDOR });
  const registeredModels = providerRegistration?.getRegisteredModels() ?? [];
  const registeredCatalog = providerRegistration?.getRegisteredCatalog() ?? [];
  const registeredCatalogById = new Map(
    registeredCatalog.map((model) => [getCloudflareModelHandle(model), model] as const),
  );
  const recentRequestMetrics = getRecentCloudflareRequestMetrics();
  const requestSummaries = summarizeCloudflareRequestMetrics(recentRequestMetrics);
  const agentEligibleCount = registeredModels.filter(
    (model) =>
      model.capabilities.toolCalling === true || typeof model.capabilities.toolCalling === "number",
  ).length;
  const sourceCounts = countCloudflareModelsBySource(registeredCatalog);
  const visibilityDiff = diffCloudflareModelIds(
    registeredModels.map((model) => model.id),
    visibleModels.map((model) => model.id),
  );

  clearCloudflareOutputChannel();
  appendCloudflareLogLine("Modelflare model inspection");
  appendCloudflareLogLine("");
  appendCloudflareLogLine("Load summary:");

  if (!lastModelLoadDiagnostics) {
    appendCloudflareLogLine("  (no completed model load recorded yet)");
  } else {
    const gatewayProviders =
      lastModelLoadDiagnostics.gatewaySupportedModelProviders.length > 0
        ? lastModelLoadDiagnostics.gatewaySupportedModelProviders.join(", ")
        : "all";
    appendCloudflareLogLine(
      `  - loadedAt=${new Date(lastModelLoadDiagnostics.loadedAt).toISOString()} | source=${lastModelLoadDiagnostics.loadedFromCache ? "cache" : "network"} | cachePolicy=${lastModelLoadDiagnostics.cachePolicy}`,
    );
    appendCloudflareLogLine(
      `  - modelFilter=${lastModelLoadDiagnostics.modelFilter} | gateway=${describeGatewaySelection(lastModelLoadDiagnostics.gatewayId)} | includeGatewaySupportedModels=${lastModelLoadDiagnostics.includeGatewaySupportedModels}`,
    );
    appendCloudflareLogLine(
      `  - gatewayProviders=${gatewayProviders} | manualEntries=${lastModelLoadDiagnostics.configuredManualModels}`,
    );
    appendCloudflareLogLine(
      `  - discovered: workers-ai=${lastModelLoadDiagnostics.discoveredCounts["workers-ai"]} | ai-gateway=${lastModelLoadDiagnostics.discoveredCounts["ai-gateway"]} | manual=${lastModelLoadDiagnostics.discoveredCounts.manual}`,
    );
    appendCloudflareLogLine(
      `  - registered: workers-ai=${lastModelLoadDiagnostics.registeredCounts["workers-ai"]} | ai-gateway=${lastModelLoadDiagnostics.registeredCounts["ai-gateway"]} | manual=${lastModelLoadDiagnostics.registeredCounts.manual}`,
    );

    if (lastModelLoadDiagnostics.duplicateHandles.length > 0) {
      appendCloudflareLogLine(
        `  - duplicate handles overridden=${lastModelLoadDiagnostics.duplicateHandles.length}`,
      );
      for (const modelHandle of lastModelLoadDiagnostics.duplicateHandles) {
        appendCloudflareLogLine(`    ${modelHandle}`);
      }
    }

    if (lastModelLoadDiagnostics.warnings.length > 0) {
      appendCloudflareLogLine("  - warnings:");
      for (const warning of lastModelLoadDiagnostics.warnings) {
        appendCloudflareLogLine(`    ${warning}`);
      }
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine(`Registered in provider: ${registeredModels.length}`);
  appendCloudflareLogLine(`Visible via vscode.lm.selectChatModels: ${visibleModels.length}`);
  appendCloudflareLogLine(`Agent-mode eligible (toolCalling): ${agentEligibleCount}`);
  appendCloudflareLogLine(
    `Registered source counts: workers-ai=${sourceCounts["workers-ai"]} | ai-gateway=${sourceCounts["ai-gateway"]} | manual=${sourceCounts.manual}`,
  );
  appendCloudflareLogLine(
    `Registered but not visible: ${visibilityDiff.registeredOnly.length} | visible but not registered: ${visibilityDiff.visibleOnly.length}`,
  );
  appendCloudflareLogLine("");
  appendCloudflareLogLine("Provider models:");

  if (registeredModels.length === 0) {
    appendCloudflareLogLine("  (none)");
  } else {
    for (const model of registeredModels) {
      appendCloudflareLogLine(
        `  - ${formatRegisteredModel(model, registeredCatalogById.get(model.id))}`,
      );
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine("VS Code visible chat models:");

  if (visibleModels.length === 0) {
    appendCloudflareLogLine("  (none)");
  } else {
    for (const model of visibleModels) {
      appendCloudflareLogLine(`  - ${formatVisibleModel(model)}`);
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine("Registered but not visible via selectChatModels:");

  if (visibilityDiff.registeredOnly.length === 0) {
    appendCloudflareLogLine("  (none)");
  } else {
    for (const modelId of visibilityDiff.registeredOnly) {
      appendCloudflareLogLine(`  - ${modelId}`);
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine("Visible but not registered in provider:");

  if (visibilityDiff.visibleOnly.length === 0) {
    appendCloudflareLogLine("  (none)");
  } else {
    for (const modelId of visibilityDiff.visibleOnly) {
      appendCloudflareLogLine(`  - ${modelId}`);
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine(`Recent request summary by model: ${requestSummaries.length}`);

  if (requestSummaries.length === 0) {
    appendCloudflareLogLine("  (none recorded yet)");
  } else {
    for (const summary of requestSummaries) {
      appendCloudflareLogLine(`  - ${formatRequestMetricSummary(summary)}`);
    }
  }

  appendCloudflareLogLine("");
  appendCloudflareLogLine(`Recent Cloudflare requests: ${recentRequestMetrics.length}`);

  if (recentRequestMetrics.length === 0) {
    appendCloudflareLogLine("  (none recorded yet)");
  } else {
    for (const metric of recentRequestMetrics) {
      appendCloudflareLogLine(`  - ${formatRecordedRequestMetric(metric)}`);
    }
  }

  showCloudflareOutputChannel(true);
  void vscode.window.showInformationMessage(
    `Modelflare: provider has ${registeredModels.length} model${registeredModels.length !== 1 ? "s" : ""}; VS Code exposes ${visibleModels.length}`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  loadCloudflareRequestMetrics(context);
  const registrationResult = registerModelProvider(context);
  providerRegistration = registrationResult.provider;
  context.subscriptions.push(registrationResult.disposable);

  // Command: Refresh models
  context.subscriptions.push(
    vscode.commands.registerCommand("modelflare.refreshModels", async () => {
      await loadAndRegisterModels(context, MANUAL_REFRESH_LOAD_OPTIONS);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("modelflare.inspectModels", async () => {
      await inspectRegisteredModels();
    }),
  );

  // Command: Securely store API key
  context.subscriptions.push(
    vscode.commands.registerCommand("modelflare.storeApiKey", async () => {
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
