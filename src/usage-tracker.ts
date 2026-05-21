import * as vscode from "vscode";
import { fetchCloudflareAiGatewayUsageMetrics } from "./cloudflare-client";
import { getModelflareConfiguration } from "./config";
import { logCloudflareWarning } from "./logging";
import {
  clearCloudflareRequestMetrics,
  createUsageTrackerSnapshot,
  getCloudflareRequestMetricsHistoryLimit,
  getRecentCloudflareRequestMetrics,
  getUsageTrackerPeriod,
  onDidChangeCloudflareRequestMetrics,
  type RecordedCloudflareRequestMetric,
  type UsageTrackerBudgetSummary,
  type UsageTrackerSnapshot,
} from "./request-metrics";
import { formatUnknownErrorMessage } from "./value-utils";

const MANAGE_USAGE_TRACKER_BUDGET_COMMAND = "modelflare.manageUsageTrackerBudget";
const REFRESH_USAGE_TRACKER_COMMAND = "modelflare.refreshUsageTracker";
const RESET_USAGE_TRACKER_COMMAND = "modelflare.resetUsageTracker";
const TRACKER_SECRET_KEY = "cloudflare-api-key";
const DEFAULT_GATEWAY_ID = "default";
const REMOTE_USAGE_REFRESH_DEBOUNCE_MS = 5_000;
const MIN_REMOTE_USAGE_REFRESH_INTERVAL_MS = 30_000;

type UsageTrackerSource = "cloudflare" | "local";

interface UsageTrackerHeroPresentation {
  title: string;
  value: string;
  unit: string;
  detail: string;
  progressValue: number;
  progressLabel: string;
  progressTone: "accent" | "warning";
}

interface UsageTrackerState {
  snapshot: UsageTrackerSnapshot;
  source: UsageTrackerSource;
  loading: boolean;
  remoteConfigured: boolean;
  gatewayId?: string;
  lastRefreshedAt?: number;
  directSupplementCount: number;
  notice?: string;
}

interface UsageTrackerStatusBarPresentation {
  text: string;
  tooltip: vscode.MarkdownString;
  warning: boolean;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number, maximumFractionDigits = 0): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits,
  });

  return formatter.format(value);
}

function formatMilliseconds(value: number | undefined): string {
  if (typeof value !== "number") {
    return "n/a";
  }

  return `${Math.round(value)}ms`;
}

function formatResetDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function formatRelativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (typeof timestamp !== "number") {
    return "No activity yet";
  }

  const diffMs = timestamp - now;
  const absDiffMs = Math.abs(diffMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absDiffMs < 60_000) {
    return "just now";
  }

  if (absDiffMs < 3_600_000) {
    return formatter.format(Math.round(diffMs / 60_000), "minute");
  }

  if (absDiffMs < 86_400_000) {
    return formatter.format(Math.round(diffMs / 3_600_000), "hour");
  }

  return formatter.format(Math.round(diffMs / 86_400_000), "day");
}

function createCommandLink(command: string, label: string, icon?: string): string {
  const title = icon ? `$(${icon}) ${label}` : label;
  return `[${title}](command:${command})`;
}

function normalizeUsageTrackerApiToken(value: string): string {
  return value.trim().replace(/^Bearer\s+/iu, "");
}

async function getUsageTrackerApiToken(
  context: vscode.ExtensionContext,
  configuredApiToken: string | undefined,
): Promise<string | undefined> {
  const storedSecret = await context.secrets.get(TRACKER_SECRET_KEY);
  if (typeof storedSecret === "string" && storedSecret.trim().length > 0) {
    return normalizeUsageTrackerApiToken(storedSecret);
  }

  if (typeof configuredApiToken === "string" && configuredApiToken.trim().length > 0) {
    return normalizeUsageTrackerApiToken(configuredApiToken);
  }

  return undefined;
}

function describeBudget(
  budget: UsageTrackerBudgetSummary,
  noun: string,
): { detail: string; progressLabel: string; progressTone: "accent" | "warning" } {
  if (budget.overBudget) {
    const excess = Math.max(0, budget.used - budget.limit);
    return {
      detail: `${formatInteger(budget.used)} of ${formatInteger(budget.limit)} ${noun}`,
      progressLabel: `${formatInteger(excess)} over budget`,
      progressTone: "warning",
    };
  }

  return {
    detail: `${formatInteger(budget.used)} of ${formatInteger(budget.limit)} ${noun}`,
    progressLabel: `${formatInteger(budget.remaining)} remaining`,
    progressTone: "accent",
  };
}

function getHeroPresentation(
  snapshot: UsageTrackerSnapshot,
  source: UsageTrackerSource,
): UsageTrackerHeroPresentation {
  if (snapshot.requestBudget) {
    const budgetDescription = describeBudget(snapshot.requestBudget, "requests");
    return {
      title: "Included request budget",
      value: formatPercent(snapshot.requestBudget.percentUsed),
      unit: "used",
      detail: budgetDescription.detail,
      progressValue: snapshot.requestBudget.percentUsed,
      progressLabel: budgetDescription.progressLabel,
      progressTone: budgetDescription.progressTone,
    };
  }

  if (snapshot.tokenBudget) {
    const budgetDescription = describeBudget(snapshot.tokenBudget, "tokens");
    return {
      title: "Tracked token budget",
      value: formatPercent(snapshot.tokenBudget.percentUsed),
      unit: "used",
      detail: budgetDescription.detail,
      progressValue: snapshot.tokenBudget.percentUsed,
      progressLabel: budgetDescription.progressLabel,
      progressTone: budgetDescription.progressTone,
    };
  }

  return {
    title: source === "cloudflare" ? "Cloudflare model usage" : "Recent workspace usage",
    value: formatInteger(snapshot.requestCount),
    unit: snapshot.requestCount === 1 ? "request" : "requests",
    detail:
      snapshot.totalTokens > 0
        ? `${formatInteger(snapshot.totalTokens)} tokens tracked in the current cycle`
        : source === "cloudflare"
          ? "No Cloudflare model usage recorded in the current cycle yet."
          : "Set a request or token budget to turn this into a progress tracker.",
    progressValue: snapshot.successRate,
    progressLabel: `${formatPercent(snapshot.successRate)} success rate`,
    progressTone: "accent",
  };
}

function getCloudflareGatewayId(gatewayId: string | undefined): string {
  const normalizedGatewayId = gatewayId?.trim();
  return normalizedGatewayId && normalizedGatewayId.length > 0
    ? normalizedGatewayId
    : DEFAULT_GATEWAY_ID;
}

function getDirectWorkersAiSupplementMetrics(
  accountId: string | undefined,
): readonly RecordedCloudflareRequestMetric[] {
  return getRecentCloudflareRequestMetrics().filter(
    (metric) =>
      (!accountId || metric.accountId === accountId) &&
      metric.endpointKind === "direct" &&
      metric.gatewayFallbackToDirect !== true,
  );
}

function createLocalUsageSnapshot(): UsageTrackerSnapshot {
  const configuration = getModelflareConfiguration();
  return createUsageTrackerSnapshot(getRecentCloudflareRequestMetrics(), {
    accountId: configuration.accountId,
    requestBudget: configuration.usageTracker.requestBudget,
    tokenBudget: configuration.usageTracker.tokenBudget,
    resetDayOfMonth: configuration.usageTracker.resetDayOfMonth,
  });
}

function renderTopModelLines(snapshot: UsageTrackerSnapshot): string[] {
  if (snapshot.topModels.length === 0) {
    return ["**Top models**", "- none yet"];
  }

  return [
    "**Top models**",
    ...snapshot.topModels.slice(0, 3).map((model) => {
      const errorSuffix =
        model.errorCount > 0 ? ` · ${formatInteger(model.errorCount)} errors` : "";
      return `- \`${model.modelHandle}\`: ${formatInteger(model.requestCount)} requests · ${formatInteger(model.totalTokens)} tokens${errorSuffix}`;
    }),
  ];
}

function createUsageTrackerTooltip(state: UsageTrackerState): vscode.MarkdownString {
  const hero = getHeroPresentation(state.snapshot, state.source);
  const accountLabel = state.snapshot.accountId
    ? `Account: **${state.snapshot.accountId}**`
    : "Account: **all locally recorded Modelflare accounts**";
  const sourceLabel =
    state.source === "cloudflare"
      ? `Source: **Cloudflare AI Gateway logs (${state.gatewayId ?? DEFAULT_GATEWAY_ID})**`
      : state.remoteConfigured
        ? "Source: **local fallback metrics**"
        : "Source: **local extension request history**";
  const markdown = new vscode.MarkdownString("", true);
  markdown.isTrusted = {
    enabledCommands: state.remoteConfigured
      ? [REFRESH_USAGE_TRACKER_COMMAND, MANAGE_USAGE_TRACKER_BUDGET_COMMAND]
      : [
          REFRESH_USAGE_TRACKER_COMMAND,
          MANAGE_USAGE_TRACKER_BUDGET_COMMAND,
          RESET_USAGE_TRACKER_COMMAND,
        ],
  };

  const lines = [
    `${state.loading ? "$(sync~spin)" : state.source === "cloudflare" ? "$(cloud)" : "$(graph)"} **Modelflare Usage**`,
    "",
    sourceLabel,
    accountLabel,
    "",
    `**${hero.title}: ${hero.value} ${hero.unit}**`,
    `${hero.detail} · ${hero.progressLabel}`,
    "",
    `Requests: **${formatInteger(state.snapshot.requestCount)}**`,
    `Tokens: **${formatInteger(state.snapshot.totalTokens)}**`,
    `Success rate: **${formatPercent(state.snapshot.successRate)}**`,
    `Avg duration: **${formatMilliseconds(state.snapshot.averageTotalDurationMs)}**`,
    `Resets: **${formatResetDate(state.snapshot.periodEndAt)}**`,
    `Last activity: **${formatRelativeTime(state.snapshot.latestRecordedAt)}**`,
  ];

  if (state.source === "cloudflare") {
    lines.push(
      `Synced: **${state.lastRefreshedAt ? formatRelativeTime(state.lastRefreshedAt) : "refreshing"}**`,
    );
    if (state.directSupplementCount > 0) {
      lines.push(
        `Direct Workers AI supplement: **${formatInteger(state.directSupplementCount)}** locally recorded direct requests`,
      );
    }
  } else {
    lines.push(
      `Tracking window: latest **${formatInteger(getCloudflareRequestMetricsHistoryLimit())}** extension requests in this workspace`,
    );
  }

  lines.push("", ...renderTopModelLines(state.snapshot));

  if (state.notice) {
    lines.push("", `$(info) ${state.notice}`);
  }

  lines.push(
    "",
    createCommandLink(
      REFRESH_USAGE_TRACKER_COMMAND,
      state.loading ? "Refreshing..." : "Refresh Usage",
      "refresh",
    ),
    "",
    createCommandLink(MANAGE_USAGE_TRACKER_BUDGET_COMMAND, "Manage Budget", "settings-gear"),
  );

  if (!state.remoteConfigured) {
    lines.push("", createCommandLink(RESET_USAGE_TRACKER_COMMAND, "Reset Local Tracker", "trash"));
  }

  markdown.value = lines.join("\n");
  return markdown;
}

function getStatusBarPresentation(state: UsageTrackerState): UsageTrackerStatusBarPresentation {
  const overBudget =
    state.snapshot.requestBudget?.overBudget === true ||
    state.snapshot.tokenBudget?.overBudget === true;
  const icon = state.loading
    ? "$(sync~spin)"
    : overBudget
      ? "$(warning)"
      : state.source === "cloudflare"
        ? "$(cloud)"
        : "$(graph)";
  const primaryValue = state.snapshot.requestBudget
    ? formatPercent(state.snapshot.requestBudget.percentUsed)
    : state.snapshot.tokenBudget
      ? formatPercent(state.snapshot.tokenBudget.percentUsed)
      : `${formatInteger(state.snapshot.requestCount)} req`;

  return {
    text: `${icon} ${primaryValue}`,
    tooltip: createUsageTrackerTooltip(state),
    warning: overBudget,
  };
}

export function registerUsageTracker(context: vscode.ExtensionContext): vscode.Disposable {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.show();

  let currentState: UsageTrackerState = {
    snapshot: createLocalUsageSnapshot(),
    source: "local",
    loading: false,
    remoteConfigured: false,
    directSupplementCount: 0,
  };
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshController: AbortController | undefined;
  let refreshSequence = 0;
  let lastRemoteRefreshStartedAt = 0;

  const applyState = (nextState: UsageTrackerState): void => {
    currentState = nextState;
    const presentation = getStatusBarPresentation(nextState);
    statusBarItem.text = presentation.text;
    statusBarItem.tooltip = presentation.tooltip;
    statusBarItem.backgroundColor = presentation.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  };

  const refreshTrackerState = async (force = false): Promise<void> => {
    const configuration = getModelflareConfiguration();
    const apiToken = await getUsageTrackerApiToken(context, configuration.apiKey);
    const remoteConfigured = Boolean(configuration.accountId) && Boolean(apiToken);
    const localSnapshot = createLocalUsageSnapshot();
    const directSupplementMetrics = getDirectWorkersAiSupplementMetrics(configuration.accountId);
    const directSupplementCount = directSupplementMetrics.length;

    if (!remoteConfigured) {
      applyState({
        snapshot: localSnapshot,
        source: "local",
        loading: false,
        remoteConfigured: false,
        directSupplementCount,
        notice:
          "Configure modelflare.accountId and a Cloudflare API token, or use Store Credentials, to query Cloudflare model usage.",
      });
      return;
    }

    const now = Date.now();
    if (!force && now - lastRemoteRefreshStartedAt < MIN_REMOTE_USAGE_REFRESH_INTERVAL_MS) {
      return;
    }

    lastRemoteRefreshStartedAt = now;
    const refreshId = ++refreshSequence;
    const gatewayId = getCloudflareGatewayId(configuration.gatewayId);
    refreshController?.abort();
    refreshController = new AbortController();

    applyState({
      snapshot: currentState.source === "cloudflare" ? currentState.snapshot : localSnapshot,
      source: currentState.source,
      loading: true,
      remoteConfigured: true,
      gatewayId,
      lastRefreshedAt: currentState.lastRefreshedAt,
      directSupplementCount,
      notice:
        currentState.source === "cloudflare"
          ? currentState.notice
          : `Refreshing Cloudflare AI Gateway usage for ${gatewayId}.`,
    });

    try {
      const period = getUsageTrackerPeriod(now, configuration.usageTracker.resetDayOfMonth);
      const remoteMetrics = await fetchCloudflareAiGatewayUsageMetrics(
        configuration.accountId!,
        apiToken!,
        {
          gatewayId,
          startDate: new Date(period.periodStartAt),
          endDate: new Date(Math.min(now, period.periodEndAt)),
          signal: refreshController.signal,
        },
      );

      if (refreshId !== refreshSequence) {
        return;
      }

      const snapshot = createUsageTrackerSnapshot([...remoteMetrics, ...directSupplementMetrics], {
        accountId: configuration.accountId,
        now,
        requestBudget: configuration.usageTracker.requestBudget,
        tokenBudget: configuration.usageTracker.tokenBudget,
        resetDayOfMonth: configuration.usageTracker.resetDayOfMonth,
      });
      applyState({
        snapshot,
        source: "cloudflare",
        loading: false,
        remoteConfigured: true,
        gatewayId,
        lastRefreshedAt: Date.now(),
        directSupplementCount,
        notice:
          directSupplementCount > 0
            ? `Using Cloudflare AI Gateway logs plus ${formatInteger(directSupplementCount)} locally recorded direct Workers AI requests.`
            : `Using Cloudflare AI Gateway logs for ${gatewayId}.`,
      });
    } catch (error) {
      if (refreshController.signal.aborted || refreshId !== refreshSequence) {
        return;
      }

      logCloudflareWarning("Failed to refresh Cloudflare model usage", error);
      applyState({
        snapshot: localSnapshot,
        source: "local",
        loading: false,
        remoteConfigured: true,
        gatewayId,
        lastRefreshedAt: Date.now(),
        directSupplementCount,
        notice: `Cloudflare model usage unavailable (${formatUnknownErrorMessage(error)}). Showing locally recorded extension requests instead.`,
      });
    }
  };

  const scheduleRefresh = (delayMs = REMOTE_USAGE_REFRESH_DEBOUNCE_MS): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshTrackerState();
    }, delayMs);
  };

  const openBudgetSettings = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "modelflare.usageTracker",
    );
  };

  const refreshUsageTracker = async (): Promise<void> => {
    await refreshTrackerState(true);
  };

  const clearUsageTrackerHistory = async (): Promise<void> => {
    const action = await vscode.window.showWarningMessage(
      "Reset locally recorded Modelflare direct usage for this workspace?",
      { modal: true },
      "Reset Tracker",
    );
    if (action !== "Reset Tracker") {
      return;
    }

    clearCloudflareRequestMetrics(context);
    await refreshTrackerState(true);
  };

  applyState(currentState);
  void refreshTrackerState(true);

  return vscode.Disposable.from(
    vscode.commands.registerCommand(MANAGE_USAGE_TRACKER_BUDGET_COMMAND, openBudgetSettings),
    vscode.commands.registerCommand(REFRESH_USAGE_TRACKER_COMMAND, refreshUsageTracker),
    vscode.commands.registerCommand(RESET_USAGE_TRACKER_COMMAND, clearUsageTrackerHistory),
    statusBarItem,
    onDidChangeCloudflareRequestMetrics(() => {
      if (currentState.remoteConfigured) {
        scheduleRefresh();
        return;
      }

      void refreshTrackerState(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("modelflare")) {
        void refreshTrackerState(true);
      }
    }),
    context.secrets.onDidChange((event) => {
      if (event.key === TRACKER_SECRET_KEY) {
        void refreshTrackerState(true);
      }
    }),
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshController?.abort();
    }),
  );
}
