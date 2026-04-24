import * as assert from "assert";
import * as vscode from "vscode";

const mockContext = {
  workspaceState: { get: () => undefined, update: () => {} },
} as unknown as vscode.ExtensionContext;

import {
  clearCloudflareRequestMetrics,
  getRecentCloudflareRequestMetrics,
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
});
