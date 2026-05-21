import * as assert from "assert";
import * as vscode from "vscode";

const mockContext = {
  workspaceState: { get: () => undefined, update: () => {} },
} as unknown as vscode.ExtensionContext;

import {
  clearCloudflareRequestMetrics,
  createUsageTrackerSnapshot,
  getRecentCloudflareRequestMetrics,
  getUsageTrackerPeriod,
  normalizeUsageTrackerResetDayOfMonth,
  recordCloudflareRequestMetric,
  summarizeCloudflareRequestMetrics,
} from "./request-metrics";

suite("request-metrics", () => {
  setup(() => {
    clearCloudflareRequestMetrics();
  });

  teardown(() => {
    clearCloudflareRequestMetrics();
  });

  test("records newest request first", () => {
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 1,
      outcome: "success",
      requestKind: "completion",
      modelHandle: "@cf/first",
      endpointKind: "direct",
      deliveryMode: "buffered-json",
      requestedStream: false,
      gatewayFallbackToDirect: false,
      totalDurationMs: 30,
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 2,
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/second",
      endpointKind: "gateway",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 40,
    });

    const recorded = getRecentCloudflareRequestMetrics();
    assert.strictEqual(recorded.length, 2);
    assert.strictEqual(recorded[0].modelHandle, "@cf/second");
    assert.strictEqual(recorded[1].modelHandle, "@cf/first");
  });

  test("returns defensive copies of usage data", () => {
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 1,
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/test",
      endpointKind: "direct",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 55,
      usage: {
        totalTokens: 9,
      },
    });

    const recorded = getRecentCloudflareRequestMetrics();
    assert.strictEqual(recorded[0].usage?.totalTokens, 9);
    if (!recorded[0].usage) {
      assert.fail("Expected usage data to be present");
    }

    recorded[0].usage.totalTokens = 99;
    assert.strictEqual(getRecentCloudflareRequestMetrics()[0].usage?.totalTokens, 9);
  });

  test("records error details for failed requests", () => {
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 3,
      outcome: "error",
      requestKind: "completion",
      modelHandle: "@cf/error",
      endpointKind: "gateway",
      deliveryMode: "unknown",
      requestedStream: true,
      gatewayFallbackToDirect: true,
      totalDurationMs: 80,
      errorStatus: 503,
      errorMessage: "Upstream unavailable",
    });

    const recorded = getRecentCloudflareRequestMetrics();
    assert.strictEqual(recorded[0].outcome, "error");
    assert.strictEqual(recorded[0].deliveryMode, "unknown");
    assert.strictEqual(recorded[0].errorStatus, 503);
    assert.strictEqual(recorded[0].errorMessage, "Upstream unavailable");
  });

  test("summarizes recent request metrics by model", () => {
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 1,
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/a",
      endpointKind: "direct",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 20,
      timeToFirstTextMs: 8,
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 2,
      outcome: "error",
      requestKind: "completion",
      modelHandle: "@cf/b",
      endpointKind: "gateway",
      deliveryMode: "unknown",
      requestedStream: true,
      gatewayFallbackToDirect: true,
      totalDurationMs: 50,
      errorStatus: 503,
      errorMessage: "Service Unavailable",
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 3,
      outcome: "cancelled",
      requestKind: "model",
      modelHandle: "@cf/a",
      endpointKind: "direct",
      deliveryMode: "unknown",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 5,
    });

    const summaries = summarizeCloudflareRequestMetrics(getRecentCloudflareRequestMetrics());
    assert.strictEqual(summaries.length, 2);
    assert.strictEqual(summaries[0].accountId, "acct-a");
    assert.strictEqual(summaries[0].modelHandle, "@cf/a");
    assert.strictEqual(summaries[0].totalCount, 2);
    assert.strictEqual(summaries[0].successCount, 1);
    assert.strictEqual(summaries[0].errorCount, 0);
    assert.strictEqual(summaries[0].cancelledCount, 1);
    assert.strictEqual(summaries[0].averageTotalDurationMs, 12.5);
    assert.strictEqual(summaries[0].averageTimeToFirstTextMs, 8);
    assert.strictEqual(summaries[0].timeToFirstTextCount, 1);
    assert.strictEqual(summaries[0].errorRate, 0);
    assert.strictEqual(summaries[0].latestFailure, undefined);

    assert.strictEqual(summaries[1].accountId, "acct-a");
    assert.strictEqual(summaries[1].modelHandle, "@cf/b");
    assert.strictEqual(summaries[1].totalCount, 1);
    assert.strictEqual(summaries[1].successCount, 0);
    assert.strictEqual(summaries[1].errorCount, 1);
    assert.strictEqual(summaries[1].cancelledCount, 0);
    assert.strictEqual(summaries[1].averageTotalDurationMs, 50);
    assert.strictEqual(summaries[1].averageTimeToFirstTextMs, undefined);
    assert.strictEqual(summaries[1].timeToFirstTextCount, 0);
    assert.strictEqual(summaries[1].errorRate, 1);
    assert.strictEqual(summaries[1].latestFailure?.status, 503);
    assert.strictEqual(summaries[1].latestFailure?.message, "Service Unavailable");
  });

  test("keeps metrics for the same model handle separate by account", () => {
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: 1,
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/shared",
      endpointKind: "direct",
      deliveryMode: "buffered-json",
      requestedStream: false,
      gatewayFallbackToDirect: false,
      totalDurationMs: 10,
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-b",
      recordedAt: 2,
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/shared",
      endpointKind: "direct",
      deliveryMode: "buffered-json",
      requestedStream: false,
      gatewayFallbackToDirect: false,
      totalDurationMs: 20,
    });

    const summaries = summarizeCloudflareRequestMetrics(getRecentCloudflareRequestMetrics());
    assert.strictEqual(summaries.length, 2);
    assert.strictEqual(summaries[0].accountId, "acct-b");
    assert.strictEqual(summaries[0].modelHandle, "@cf/shared");
    assert.strictEqual(summaries[1].accountId, "acct-a");
    assert.strictEqual(summaries[1].modelHandle, "@cf/shared");
  });

  test("normalizes usage tracker reset days into a valid day-of-month", () => {
    assert.strictEqual(normalizeUsageTrackerResetDayOfMonth(undefined), 1);
    assert.strictEqual(normalizeUsageTrackerResetDayOfMonth(0), 1);
    assert.strictEqual(normalizeUsageTrackerResetDayOfMonth(12.8), 12);
    assert.strictEqual(normalizeUsageTrackerResetDayOfMonth(99), 31);
  });

  test("computes usage tracker periods using the configured reset day", () => {
    const now = new Date(2026, 4, 21, 10, 0, 0, 0).getTime();
    const currentPeriod = getUsageTrackerPeriod(now, 15);
    assert.strictEqual(currentPeriod.periodStartAt, new Date(2026, 4, 15, 0, 0, 0, 0).getTime());
    assert.strictEqual(currentPeriod.periodEndAt, new Date(2026, 5, 15, 0, 0, 0, 0).getTime());

    const beforeReset = getUsageTrackerPeriod(new Date(2026, 4, 10, 10, 0, 0, 0).getTime(), 15);
    assert.strictEqual(beforeReset.periodStartAt, new Date(2026, 3, 15, 0, 0, 0, 0).getTime());
    assert.strictEqual(beforeReset.periodEndAt, new Date(2026, 4, 15, 0, 0, 0, 0).getTime());

    const monthEndReset = getUsageTrackerPeriod(new Date(2026, 1, 12, 10, 0, 0, 0).getTime(), 31);
    assert.strictEqual(monthEndReset.periodStartAt, new Date(2026, 0, 31, 0, 0, 0, 0).getTime());
    assert.strictEqual(monthEndReset.periodEndAt, new Date(2026, 1, 28, 0, 0, 0, 0).getTime());
  });

  test("creates a budget-aware usage tracker snapshot for the active period", () => {
    const now = new Date(2026, 4, 21, 12, 0, 0, 0).getTime();

    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: new Date(2026, 4, 18, 8, 0, 0, 0).getTime(),
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/meta/llama",
      endpointKind: "direct",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 120,
      timeToFirstTextMs: 30,
      usage: {
        promptTokens: 90,
        completionTokens: 30,
        totalTokens: 120,
      },
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: new Date(2026, 4, 20, 9, 0, 0, 0).getTime(),
      outcome: "error",
      requestKind: "completion",
      modelHandle: "openai/gpt-5-mini",
      endpointKind: "gateway",
      deliveryMode: "unknown",
      requestedStream: true,
      gatewayFallbackToDirect: true,
      totalDurationMs: 210,
      errorStatus: 503,
      errorMessage: "Service Unavailable",
      usage: {
        promptTokens: 15,
        completionTokens: 5,
      },
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: new Date(2026, 4, 20, 11, 0, 0, 0).getTime(),
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/meta/llama",
      endpointKind: "direct",
      deliveryMode: "buffered-json",
      requestedStream: false,
      gatewayFallbackToDirect: false,
      totalDurationMs: 80,
      usage: {
        totalTokens: 60,
      },
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-b",
      recordedAt: new Date(2026, 4, 19, 12, 0, 0, 0).getTime(),
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/other-account",
      endpointKind: "direct",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 25,
      usage: {
        totalTokens: 500,
      },
    });
    recordCloudflareRequestMetric(mockContext, {
      accountId: "acct-a",
      recordedAt: new Date(2026, 4, 10, 7, 0, 0, 0).getTime(),
      outcome: "success",
      requestKind: "model",
      modelHandle: "@cf/previous-period",
      endpointKind: "direct",
      deliveryMode: "event-stream",
      requestedStream: true,
      gatewayFallbackToDirect: false,
      totalDurationMs: 50,
      usage: {
        totalTokens: 999,
      },
    });

    const snapshot = createUsageTrackerSnapshot(getRecentCloudflareRequestMetrics(), {
      accountId: "acct-a",
      now,
      resetDayOfMonth: 15,
      requestBudget: 4,
      tokenBudget: 250,
      maxTopModels: 2,
    });

    assert.strictEqual(snapshot.accountId, "acct-a");
    assert.strictEqual(snapshot.requestCount, 3);
    assert.strictEqual(snapshot.successCount, 2);
    assert.strictEqual(snapshot.errorCount, 1);
    assert.strictEqual(snapshot.cancelledCount, 0);
    assert.strictEqual(snapshot.successRate, 2 / 3);
    assert.strictEqual(snapshot.totalTokens, 200);
    assert.strictEqual(snapshot.promptTokens, 105);
    assert.strictEqual(snapshot.completionTokens, 35);
    assert.strictEqual(snapshot.averageTotalDurationMs, (120 + 210 + 80) / 3);
    assert.strictEqual(snapshot.averageTimeToFirstTextMs, 30);
    assert.strictEqual(snapshot.requestBudget?.used, 3);
    assert.strictEqual(snapshot.requestBudget?.remaining, 1);
    assert.strictEqual(snapshot.requestBudget?.percentUsed, 0.75);
    assert.strictEqual(snapshot.requestBudget?.overBudget, false);
    assert.strictEqual(snapshot.tokenBudget?.used, 200);
    assert.strictEqual(snapshot.tokenBudget?.remaining, 50);
    assert.strictEqual(snapshot.tokenBudget?.percentUsed, 0.8);
    assert.strictEqual(snapshot.topModels.length, 2);
    assert.strictEqual(snapshot.topModels[0]?.modelHandle, "@cf/meta/llama");
    assert.strictEqual(snapshot.topModels[0]?.requestCount, 2);
    assert.strictEqual(snapshot.topModels[0]?.totalTokens, 180);
    assert.strictEqual(snapshot.topModels[1]?.modelHandle, "openai/gpt-5-mini");
    assert.deepStrictEqual(snapshot.requestKinds, [
      { requestKind: "model", count: 2 },
      { requestKind: "completion", count: 1 },
    ]);
  });
});
