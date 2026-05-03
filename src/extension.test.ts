import * as assert from "assert";
import * as vscode from "vscode";
import {
  formatRequestMetricSummary,
  formatRecordedRequestMetric,
  normalizeApiKey,
  getNoModelsFoundMessage,
  mergeLoadModelsOptions,
  synchronizeCloudflareModelPicker,
  shouldReloadForConfigurationChange,
  shouldReloadForSecretChange,
  type LoadModelsOptions,
} from "./extension";
import type {
  AggregatedCloudflareRequestMetric,
  RecordedCloudflareRequestMetric,
} from "./request-metrics";

suite("extension", () => {
  const automaticLoadOptions: LoadModelsOptions = {
    notifyOnMissingConfiguration: false,
    notifyOnSuccess: false,
    notifyOnError: false,
    cachePolicy: "prefer-cache",
  };

  const interactiveLoadOptions: LoadModelsOptions = {
    notifyOnMissingConfiguration: true,
    notifyOnSuccess: true,
    notifyOnError: true,
    cachePolicy: "prefer-cache",
  };

  const manualRefreshLoadOptions: LoadModelsOptions = {
    notifyOnMissingConfiguration: true,
    notifyOnSuccess: true,
    notifyOnError: true,
    cachePolicy: "refresh",
  };

  // -------------------------------------------------------------------------
  // normalizeApiKey
  // -------------------------------------------------------------------------

  suite("normalizeApiKey", () => {
    test("returns key unchanged when already clean", () => {
      assert.strictEqual(normalizeApiKey("abc123"), "abc123");
    });

    test("trims leading and trailing whitespace", () => {
      assert.strictEqual(normalizeApiKey("  abc123  "), "abc123");
    });

    test("strips 'Bearer ' prefix (lowercase)", () => {
      assert.strictEqual(normalizeApiKey("bearer abc123"), "abc123");
    });

    test("strips 'Bearer ' prefix (mixed case)", () => {
      assert.strictEqual(normalizeApiKey("Bearer abc123"), "abc123");
    });

    test("strips 'Bearer ' prefix (uppercase)", () => {
      assert.strictEqual(normalizeApiKey("BEARER abc123"), "abc123");
    });

    test("trims whitespace before stripping Bearer prefix", () => {
      assert.strictEqual(normalizeApiKey("  Bearer abc123  "), "abc123");
    });

    test("does not strip non-Bearer prefix", () => {
      assert.strictEqual(normalizeApiKey("Token abc123"), "Token abc123");
    });
  });

  // -------------------------------------------------------------------------
  // getNoModelsFoundMessage
  // -------------------------------------------------------------------------

  suite("getNoModelsFoundMessage", () => {
    test("returns account-level message for 'all' filter", () => {
      const msg = getNoModelsFoundMessage("all");
      assert.ok(msg.includes("no models"), `Unexpected message: ${msg}`);
      assert.ok(!msg.includes('"all"'), `Should not mention filter name: ${msg}`);
    });

    test("mentions the filter name for a specific filter", () => {
      const msg = getNoModelsFoundMessage("Text Generation");
      assert.ok(msg.includes("Text Generation"), `Expected filter name in: ${msg}`);
    });

    test("suggests changing filter to 'all' for specific filter", () => {
      const msg = getNoModelsFoundMessage("Speech Recognition");
      assert.ok(msg.toLowerCase().includes("all"), `Expected 'all' suggestion in: ${msg}`);
    });
  });

  suite("automatic reload triggers", () => {
    test("reloads for cloudflareCopilot configuration changes", () => {
      const event = {
        affectsConfiguration: (section: string) => section === "cloudflareCopilot",
      } as vscode.ConfigurationChangeEvent;

      assert.strictEqual(shouldReloadForConfigurationChange(event), true);
    });

    test("ignores unrelated configuration changes", () => {
      const event = {
        affectsConfiguration: () => false,
      } as vscode.ConfigurationChangeEvent;

      assert.strictEqual(shouldReloadForConfigurationChange(event), false);
    });

    test("reloads when the Cloudflare secret changes", () => {
      assert.strictEqual(shouldReloadForSecretChange({ key: "cloudflare-api-key" }), true);
    });

    test("ignores unrelated secret changes", () => {
      assert.strictEqual(shouldReloadForSecretChange({ key: "other-key" }), false);
    });
  });

  suite("mergeLoadModelsOptions", () => {
    test("preserves manual refresh semantics when it is merged with an automatic reload", () => {
      assert.deepStrictEqual(
        mergeLoadModelsOptions(manualRefreshLoadOptions, automaticLoadOptions),
        manualRefreshLoadOptions,
      );
      assert.deepStrictEqual(
        mergeLoadModelsOptions(automaticLoadOptions, manualRefreshLoadOptions),
        manualRefreshLoadOptions,
      );
    });

    test("keeps the most visible notification flags across queued prefer-cache loads", () => {
      assert.deepStrictEqual(
        mergeLoadModelsOptions(automaticLoadOptions, interactiveLoadOptions),
        interactiveLoadOptions,
      );
    });
  });

  suite("synchronizeCloudflareModelPicker", () => {
    test("queries VS Code for the Cloudflare vendor models", async () => {
      let capturedSelector: Parameters<typeof vscode.lm.selectChatModels>[0] | undefined;

      await synchronizeCloudflareModelPicker(async (selector) => {
        capturedSelector = selector;
        return [];
      });

      assert.deepStrictEqual(capturedSelector, { vendor: "cloudflare" });
    });

    test("swallows picker synchronization errors", async () => {
      const capturedWarnings: Array<{ message: string; error: unknown }> = [];

      await assert.doesNotReject(async () => {
        await synchronizeCloudflareModelPicker(
          async () => {
            throw new Error("picker unavailable");
          },
          (message, error) => {
            capturedWarnings.push({ message, error });
          },
        );
      });

      assert.strictEqual(capturedWarnings.length, 1);
      assert.strictEqual(
        capturedWarnings[0]?.message,
        "Failed to synchronize Cloudflare model picker",
      );
      assert.ok(capturedWarnings[0]?.error instanceof Error);
    });
  });

  suite("formatRecordedRequestMetric", () => {
    test("includes transport, durations, fallback, and usage when present", () => {
      const metric: RecordedCloudflareRequestMetric = {
        accountId: "acct-a",
        recordedAt: Date.UTC(2026, 3, 24, 12, 0, 0),
        outcome: "success",
        requestKind: "model",
        modelHandle: "@cf/meta/llama",
        endpointKind: "direct",
        deliveryMode: "event-stream",
        requestedStream: true,
        gatewayFallbackToDirect: true,
        totalDurationMs: 120,
        timeToFirstTextMs: 35,
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      };

      const formatted = formatRecordedRequestMetric(metric);
      assert.ok(formatted.includes("2026-04-24T12:00:00.000Z"), formatted);
      assert.ok(formatted.includes("account=acct-a"), formatted);
      assert.ok(formatted.includes("model @cf/meta/llama"), formatted);
      assert.ok(formatted.includes("outcome=success"), formatted);
      assert.ok(formatted.includes("transport=direct/event-stream"), formatted);
      assert.ok(formatted.includes("requestedStream=true"), formatted);
      assert.ok(formatted.includes("total=120ms"), formatted);
      assert.ok(formatted.includes("ttft=35ms"), formatted);
      assert.ok(formatted.includes("fallback=gateway->direct"), formatted);
      assert.ok(formatted.includes("usage=total=18,prompt=11,completion=7"), formatted);
    });

    test("renders ttft as n/a when no first-text timing is available", () => {
      const metric: RecordedCloudflareRequestMetric = {
        accountId: "acct-a",
        recordedAt: 0,
        outcome: "cancelled",
        requestKind: "completion",
        modelHandle: "@cf/completion",
        endpointKind: "direct",
        deliveryMode: "unknown",
        requestedStream: false,
        gatewayFallbackToDirect: false,
        totalDurationMs: 42,
      };

      const formatted = formatRecordedRequestMetric(metric);
      assert.ok(formatted.includes("ttft=n/a"), formatted);
      assert.ok(formatted.includes("outcome=cancelled"), formatted);
      assert.ok(!formatted.includes("fallback=gateway->direct"), formatted);
      assert.ok(!formatted.includes("usage="), formatted);
      assert.ok(!formatted.includes("error="), formatted);
    });

    test("includes status and error details for failed requests", () => {
      const metric: RecordedCloudflareRequestMetric = {
        accountId: "acct-a",
        recordedAt: 0,
        outcome: "error",
        requestKind: "completion",
        modelHandle: "@cf/error",
        endpointKind: "gateway",
        deliveryMode: "unknown",
        requestedStream: true,
        gatewayFallbackToDirect: true,
        totalDurationMs: 87,
        errorStatus: 503,
        errorMessage: "Cloudflare completion request failed via gateway (503): Service Unavailable",
      };

      const formatted = formatRecordedRequestMetric(metric);
      assert.ok(formatted.includes("outcome=error"), formatted);
      assert.ok(formatted.includes("status=503"), formatted);
      assert.ok(
        formatted.includes(
          "error=Cloudflare completion request failed via gateway (503): Service Unavailable",
        ),
        formatted,
      );
    });
  });

  suite("formatRequestMetricSummary", () => {
    test("includes counts and latest failure details when present", () => {
      const summary: AggregatedCloudflareRequestMetric = {
        accountId: "acct-a",
        modelHandle: "@cf/meta/llama",
        totalCount: 4,
        successCount: 2,
        errorCount: 1,
        cancelledCount: 1,
        averageTotalDurationMs: 42.5,
        averageTimeToFirstTextMs: 18.2,
        timeToFirstTextCount: 2,
        errorRate: 0.25,
        latestRecordedAt: Date.UTC(2026, 3, 24, 12, 5, 0),
        latestFailure: {
          recordedAt: Date.UTC(2026, 3, 24, 12, 0, 0),
          requestKind: "completion",
          status: 503,
          message: "Cloudflare completion request failed via gateway (503): Service Unavailable",
        },
      };

      const formatted = formatRequestMetricSummary(summary);
      assert.ok(formatted.includes("account=acct-a"), formatted);
      assert.ok(formatted.includes("@cf/meta/llama"), formatted);
      assert.ok(formatted.includes("total=4 success=2 error=1 cancelled=1"), formatted);
      assert.ok(formatted.includes("avgDuration=43ms"), formatted);
      assert.ok(formatted.includes("avgTtft=18ms"), formatted);
      assert.ok(formatted.includes("errorRate=25%"), formatted);
      assert.ok(formatted.includes("latestFailure=2026-04-24T12:00:00.000Z"), formatted);
      assert.ok(formatted.includes("request=completion"), formatted);
      assert.ok(formatted.includes("status=503"), formatted);
      assert.ok(
        formatted.includes(
          "error=Cloudflare completion request failed via gateway (503): Service Unavailable",
        ),
        formatted,
      );
    });

    test("shows latestFailure=none when a model has no recent errors", () => {
      const summary: AggregatedCloudflareRequestMetric = {
        accountId: "acct-a",
        modelHandle: "@cf/success-only",
        totalCount: 3,
        successCount: 3,
        errorCount: 0,
        cancelledCount: 0,
        averageTotalDurationMs: 20,
        averageTimeToFirstTextMs: undefined,
        timeToFirstTextCount: 0,
        errorRate: 0,
        latestRecordedAt: 5,
      };

      const formatted = formatRequestMetricSummary(summary);
      assert.ok(formatted.includes("avgDuration=20ms"), formatted);
      assert.ok(formatted.includes("avgTtft=n/a"), formatted);
      assert.ok(formatted.includes("errorRate=0%"), formatted);
      assert.ok(formatted.includes("latestFailure=none"), formatted);
      assert.ok(!formatted.includes("status="), formatted);
      assert.ok(!formatted.includes("request="), formatted);
    });
  });
});
