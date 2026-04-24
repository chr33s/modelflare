import * as vscode from "vscode";

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

interface MutableAggregatedCloudflareRequestMetric extends AggregatedCloudflareRequestMetric {
  totalDurationMsSum: number;
  timeToFirstTextMsSum: number;
}

const MAX_RECORDED_REQUEST_METRICS = 25;
const TELEMETRY_STATE_KEY = "cloudflareCopilot.requestMetrics";

let recordedRequestMetrics: RecordedCloudflareRequestMetric[] = [];

export function loadCloudflareRequestMetrics(context: vscode.ExtensionContext): void {
  try {
    const stored =
      context.workspaceState.get<RecordedCloudflareRequestMetric[]>(TELEMETRY_STATE_KEY);
    if (Array.isArray(stored)) {
      recordedRequestMetrics = stored;
    }
  } catch (err) {
    console.error("Failed to load metrics telemetry", err);
  }
}

export function saveCloudflareRequestMetrics(context: vscode.ExtensionContext): void {
  try {
    context.workspaceState.update(TELEMETRY_STATE_KEY, recordedRequestMetrics);
  } catch (err) {
    console.error("Failed to save metrics telemetry", err);
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
