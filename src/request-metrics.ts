import * as vscode from "vscode";
import { logCloudflareError } from "./logging";

export interface RecordedCloudflareUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type RecordedCloudflareRequestOutcome = "success" | "error" | "cancelled";
export type RecordedCloudflareDeliveryMode = "event-stream" | "buffered-json" | "unknown";

export interface RecordedCloudflareRequestMetric {
  accountId: string;
  recordedAt: number;
  outcome: RecordedCloudflareRequestOutcome;
  requestKind: string;
  modelHandle: string;
  endpointKind: "gateway" | "direct";
  deliveryMode: RecordedCloudflareDeliveryMode;
  requestedStream: boolean;
  gatewayFallbackToDirect: boolean;
  totalDurationMs: number;
  timeToFirstTextMs?: number;
  errorStatus?: number;
  errorMessage?: string;
  usage?: RecordedCloudflareUsage;
}

export interface AggregatedCloudflareRequestFailure {
  recordedAt: number;
  requestKind: string;
  status?: number;
  message?: string;
}

export interface AggregatedCloudflareRequestMetric {
  accountId: string;
  modelHandle: string;
  totalCount: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  averageTotalDurationMs: number;
  averageTimeToFirstTextMs?: number;
  timeToFirstTextCount: number;
  errorRate: number;
  latestRecordedAt: number;
  latestFailure?: AggregatedCloudflareRequestFailure;
}

export interface UsageTrackerBudgetSummary {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  overBudget: boolean;
}

export interface UsageTrackerRequestKindSummary {
  requestKind: string;
  count: number;
}

export interface UsageTrackerTopModelSummary {
  modelHandle: string;
  requestCount: number;
  totalTokens: number;
  errorCount: number;
  latestRecordedAt: number;
}

export interface UsageTrackerSnapshot {
  accountId?: string;
  periodStartAt: number;
  periodEndAt: number;
  resetDayOfMonth: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  successRate: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  averageTotalDurationMs?: number;
  averageTimeToFirstTextMs?: number;
  latestRecordedAt?: number;
  requestBudget?: UsageTrackerBudgetSummary;
  tokenBudget?: UsageTrackerBudgetSummary;
  requestKinds: readonly UsageTrackerRequestKindSummary[];
  topModels: readonly UsageTrackerTopModelSummary[];
}

export interface UsageTrackerSnapshotOptions {
  accountId?: string;
  now?: number;
  resetDayOfMonth?: number;
  requestBudget?: number;
  tokenBudget?: number;
  maxTopModels?: number;
}

interface MutableAggregatedCloudflareRequestMetric extends AggregatedCloudflareRequestMetric {
  totalDurationMsSum: number;
  timeToFirstTextMsSum: number;
}

const MAX_RECORDED_REQUEST_METRICS = 500;
const TELEMETRY_STATE_KEY = "modelflare.requestMetrics";

let recordedRequestMetrics: RecordedCloudflareRequestMetric[] = [];
const requestMetricsChangedEmitter = new vscode.EventEmitter<
  readonly RecordedCloudflareRequestMetric[]
>();

export const onDidChangeCloudflareRequestMetrics = requestMetricsChangedEmitter.event;

export function getCloudflareRequestMetricsHistoryLimit(): number {
  return MAX_RECORDED_REQUEST_METRICS;
}

function emitCloudflareRequestMetricsChanged(): void {
  requestMetricsChangedEmitter.fire(getRecentCloudflareRequestMetrics());
}

function getDaysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function getResetPointForMonth(year: number, monthIndex: number, resetDayOfMonth: number): number {
  return new Date(
    year,
    monthIndex,
    Math.min(resetDayOfMonth, getDaysInMonth(year, monthIndex)),
  ).getTime();
}

function normalizeUsageTrackerBudget(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function createUsageTrackerBudgetSummary(
  used: number,
  limit: number | undefined,
): UsageTrackerBudgetSummary | undefined {
  if (typeof limit !== "number") {
    return undefined;
  }

  const remaining = Math.max(0, limit - used);
  const percentUsed = limit > 0 ? Math.min(used / limit, 1) : 0;
  return {
    used,
    limit,
    remaining,
    percentUsed,
    overBudget: used > limit,
  };
}

export function normalizeUsageTrackerResetDayOfMonth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(31, Math.max(1, Math.trunc(value)));
}

export function getUsageTrackerPeriod(
  now = Date.now(),
  resetDayOfMonth = 1,
): {
  periodStartAt: number;
  periodEndAt: number;
  resetDayOfMonth: number;
} {
  const normalizedResetDayOfMonth = normalizeUsageTrackerResetDayOfMonth(resetDayOfMonth);
  const currentDate = new Date(now);
  const currentMonthReset = getResetPointForMonth(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    normalizedResetDayOfMonth,
  );

  const periodStartAt =
    now >= currentMonthReset
      ? currentMonthReset
      : getResetPointForMonth(
          currentDate.getFullYear(),
          currentDate.getMonth() - 1,
          normalizedResetDayOfMonth,
        );
  const periodEndAt =
    now >= currentMonthReset
      ? getResetPointForMonth(
          currentDate.getFullYear(),
          currentDate.getMonth() + 1,
          normalizedResetDayOfMonth,
        )
      : currentMonthReset;

  return {
    periodStartAt,
    periodEndAt,
    resetDayOfMonth: normalizedResetDayOfMonth,
  };
}

export function createUsageTrackerSnapshot(
  metrics: readonly RecordedCloudflareRequestMetric[] = recordedRequestMetrics,
  options: UsageTrackerSnapshotOptions = {},
): UsageTrackerSnapshot {
  const accountId = options.accountId?.trim() || undefined;
  const maxTopModels =
    typeof options.maxTopModels === "number" && Number.isFinite(options.maxTopModels)
      ? Math.max(1, Math.trunc(options.maxTopModels))
      : 5;
  const period = getUsageTrackerPeriod(options.now, options.resetDayOfMonth);
  const requestKindCounts = new Map<string, number>();
  const topModels = new Map<
    string,
    {
      requestCount: number;
      totalTokens: number;
      errorCount: number;
      latestRecordedAt: number;
    }
  >();

  let requestCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let cancelledCount = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalDurationMsSum = 0;
  let timeToFirstTextMsSum = 0;
  let timeToFirstTextCount = 0;
  let latestRecordedAt: number | undefined;

  for (const metric of metrics) {
    if (metric.recordedAt < period.periodStartAt || metric.recordedAt >= period.periodEndAt) {
      continue;
    }

    if (accountId && metric.accountId !== accountId) {
      continue;
    }

    requestCount += 1;
    totalDurationMsSum += metric.totalDurationMs;
    latestRecordedAt =
      typeof latestRecordedAt === "number"
        ? Math.max(latestRecordedAt, metric.recordedAt)
        : metric.recordedAt;

    if (metric.outcome === "success") {
      successCount += 1;
    } else if (metric.outcome === "error") {
      errorCount += 1;
    } else {
      cancelledCount += 1;
    }

    if (typeof metric.timeToFirstTextMs === "number") {
      timeToFirstTextCount += 1;
      timeToFirstTextMsSum += metric.timeToFirstTextMs;
    }

    const metricPromptTokens = metric.usage?.promptTokens ?? 0;
    const metricCompletionTokens = metric.usage?.completionTokens ?? 0;
    const metricTotalTokens =
      metric.usage?.totalTokens ?? metricPromptTokens + metricCompletionTokens;
    promptTokens += metricPromptTokens;
    completionTokens += metricCompletionTokens;
    totalTokens += metricTotalTokens;

    requestKindCounts.set(metric.requestKind, (requestKindCounts.get(metric.requestKind) ?? 0) + 1);

    const topModelEntry = topModels.get(metric.modelHandle) ?? {
      requestCount: 0,
      totalTokens: 0,
      errorCount: 0,
      latestRecordedAt: metric.recordedAt,
    };
    topModelEntry.requestCount += 1;
    topModelEntry.totalTokens += metricTotalTokens;
    topModelEntry.latestRecordedAt = Math.max(topModelEntry.latestRecordedAt, metric.recordedAt);
    if (metric.outcome === "error") {
      topModelEntry.errorCount += 1;
    }
    topModels.set(metric.modelHandle, topModelEntry);
  }

  return {
    accountId,
    periodStartAt: period.periodStartAt,
    periodEndAt: period.periodEndAt,
    resetDayOfMonth: period.resetDayOfMonth,
    requestCount,
    successCount,
    errorCount,
    cancelledCount,
    successRate: requestCount > 0 ? successCount / requestCount : 0,
    totalTokens,
    promptTokens,
    completionTokens,
    averageTotalDurationMs: requestCount > 0 ? totalDurationMsSum / requestCount : undefined,
    averageTimeToFirstTextMs:
      timeToFirstTextCount > 0 ? timeToFirstTextMsSum / timeToFirstTextCount : undefined,
    latestRecordedAt,
    requestBudget: createUsageTrackerBudgetSummary(
      requestCount,
      normalizeUsageTrackerBudget(options.requestBudget),
    ),
    tokenBudget: createUsageTrackerBudgetSummary(
      totalTokens,
      normalizeUsageTrackerBudget(options.tokenBudget),
    ),
    requestKinds: [...requestKindCounts.entries()]
      .map(([requestKind, count]) => ({ requestKind, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.requestKind.localeCompare(right.requestKind),
      ),
    topModels: [...topModels.entries()]
      .map(([modelHandle, summary]) => ({
        modelHandle,
        requestCount: summary.requestCount,
        totalTokens: summary.totalTokens,
        errorCount: summary.errorCount,
        latestRecordedAt: summary.latestRecordedAt,
      }))
      .sort(
        (left, right) =>
          right.requestCount - left.requestCount ||
          right.totalTokens - left.totalTokens ||
          right.latestRecordedAt - left.latestRecordedAt ||
          left.modelHandle.localeCompare(right.modelHandle),
      )
      .slice(0, maxTopModels),
  };
}

export function loadCloudflareRequestMetrics(context: vscode.ExtensionContext): void {
  try {
    const stored =
      context.workspaceState.get<RecordedCloudflareRequestMetric[]>(TELEMETRY_STATE_KEY);
    if (Array.isArray(stored)) {
      recordedRequestMetrics = stored;
    }
    emitCloudflareRequestMetricsChanged();
  } catch (err) {
    logCloudflareError("Failed to load metrics telemetry", err);
  }
}

export function saveCloudflareRequestMetrics(context: vscode.ExtensionContext): void {
  try {
    const updateResult = context.workspaceState.update(
      TELEMETRY_STATE_KEY,
      recordedRequestMetrics,
    ) as Thenable<void> | void;

    if (updateResult) {
      void Promise.resolve(updateResult).catch((err: unknown) => {
        logCloudflareError("Failed to save metrics telemetry", err);
      });
    }
  } catch (err) {
    logCloudflareError("Failed to save metrics telemetry", err);
  }
}

export function recordCloudflareRequestMetric(
  context: vscode.ExtensionContext,
  metric: RecordedCloudflareRequestMetric,
): void {
  recordedRequestMetrics.unshift({
    ...metric,
    usage: metric.usage ? { ...metric.usage } : undefined,
  });

  if (recordedRequestMetrics.length > MAX_RECORDED_REQUEST_METRICS) {
    recordedRequestMetrics.length = MAX_RECORDED_REQUEST_METRICS;
  }

  saveCloudflareRequestMetrics(context);
  emitCloudflareRequestMetricsChanged();
}

export function getRecentCloudflareRequestMetrics(): readonly RecordedCloudflareRequestMetric[] {
  return recordedRequestMetrics.map((metric) => ({
    ...metric,
    usage: metric.usage ? { ...metric.usage } : undefined,
  }));
}

export function clearCloudflareRequestMetrics(context?: vscode.ExtensionContext): void {
  recordedRequestMetrics.length = 0;
  if (context) {
    saveCloudflareRequestMetrics(context);
  }
  emitCloudflareRequestMetricsChanged();
}

export function summarizeCloudflareRequestMetrics(
  metrics: readonly RecordedCloudflareRequestMetric[] = recordedRequestMetrics,
): readonly AggregatedCloudflareRequestMetric[] {
  const summaries = new Map<string, MutableAggregatedCloudflareRequestMetric>();

  for (const metric of metrics) {
    const summaryKey = `${metric.accountId}\u0000${metric.modelHandle}`;
    const summary = summaries.get(summaryKey) ?? {
      accountId: metric.accountId,
      modelHandle: metric.modelHandle,
      totalCount: 0,
      successCount: 0,
      errorCount: 0,
      cancelledCount: 0,
      averageTotalDurationMs: 0,
      timeToFirstTextCount: 0,
      errorRate: 0,
      latestRecordedAt: metric.recordedAt,
      totalDurationMsSum: 0,
      timeToFirstTextMsSum: 0,
    };

    summary.totalCount += 1;
    summary.latestRecordedAt = Math.max(summary.latestRecordedAt, metric.recordedAt);
    summary.totalDurationMsSum += metric.totalDurationMs;

    if (typeof metric.timeToFirstTextMs === "number") {
      summary.timeToFirstTextCount += 1;
      summary.timeToFirstTextMsSum += metric.timeToFirstTextMs;
    }

    if (metric.outcome === "success") {
      summary.successCount += 1;
    } else if (metric.outcome === "error") {
      summary.errorCount += 1;

      if (!summary.latestFailure || metric.recordedAt >= summary.latestFailure.recordedAt) {
        summary.latestFailure = {
          recordedAt: metric.recordedAt,
          requestKind: metric.requestKind,
          status: metric.errorStatus,
          message: metric.errorMessage,
        };
      }
    } else {
      summary.cancelledCount += 1;
    }

    summaries.set(summaryKey, summary);
  }

  return [...summaries.values()]
    .sort(
      (left, right) =>
        right.latestRecordedAt - left.latestRecordedAt ||
        left.accountId.localeCompare(right.accountId) ||
        left.modelHandle.localeCompare(right.modelHandle),
    )
    .map((summary) => ({
      accountId: summary.accountId,
      modelHandle: summary.modelHandle,
      totalCount: summary.totalCount,
      successCount: summary.successCount,
      errorCount: summary.errorCount,
      cancelledCount: summary.cancelledCount,
      averageTotalDurationMs:
        summary.totalCount > 0 ? summary.totalDurationMsSum / summary.totalCount : 0,
      averageTimeToFirstTextMs:
        summary.timeToFirstTextCount > 0
          ? summary.timeToFirstTextMsSum / summary.timeToFirstTextCount
          : undefined,
      timeToFirstTextCount: summary.timeToFirstTextCount,
      errorRate: summary.totalCount > 0 ? summary.errorCount / summary.totalCount : 0,
      latestRecordedAt: summary.latestRecordedAt,
      latestFailure: summary.latestFailure ? { ...summary.latestFailure } : undefined,
    }));
}
