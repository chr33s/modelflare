import * as assert from "assert";
import * as vscode from "vscode";
import { loadCachedCloudflareModels, saveCachedCloudflareModels } from "./model-cache";
import type { CloudflareModel } from "./cloudflare-client";
import { TEXT_GENERATION_MODEL_FILTER } from "./model-filter";

interface MockMemento {
  readonly values: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void;
}

function createMockMemento(): MockMemento {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      values.set(key, value);
    },
  };
}

function createMockContext(): vscode.ExtensionContext {
  const workspaceState = createMockMemento();
  return {
    workspaceState,
  } as unknown as vscode.ExtensionContext;
}

function makeModel(id: string, name: string): CloudflareModel {
  return {
    id,
    name,
    task: { id: "text-generation", name: "Text Generation" },
    detectedCapabilities: { toolCalling: true },
  };
}

suite("model-cache", () => {
  test("restores saved models for the same cache query", () => {
    const context = createMockContext();
    const models = [makeModel("uuid-1", "@cf/meta/llama-3.3-8b-instruct")];

    saveCachedCloudflareModels(
      context,
      {
        accountId: "acct-a",
        apiKey: "secret-a",
        modelFilter: TEXT_GENERATION_MODEL_FILTER,
      },
      models,
    );

    const cached = loadCachedCloudflareModels(context, {
      accountId: "acct-a",
      apiKey: "secret-a",
      modelFilter: TEXT_GENERATION_MODEL_FILTER,
    });

    assert.ok(cached);
    assert.strictEqual(typeof cached?.cachedAt, "number");
    assert.deepStrictEqual(cached?.models, models);
  });

  test("returns undefined when the api key fingerprint changes", () => {
    const context = createMockContext();
    saveCachedCloudflareModels(
      context,
      {
        accountId: "acct-a",
        apiKey: "secret-a",
        modelFilter: TEXT_GENERATION_MODEL_FILTER,
      },
      [makeModel("uuid-1", "@cf/meta/llama-3.3-8b-instruct")],
    );

    const cached = loadCachedCloudflareModels(context, {
      accountId: "acct-a",
      apiKey: "secret-b",
      modelFilter: TEXT_GENERATION_MODEL_FILTER,
    });

    assert.strictEqual(cached, undefined);
  });

  test("treats capability override objects with different key order as the same cache key", () => {
    const context = createMockContext();
    const models = [makeModel("uuid-1", "@cf/meta/llama-3.3-8b-instruct")];

    saveCachedCloudflareModels(
      context,
      {
        accountId: "acct-a",
        apiKey: "secret-a",
        modelFilter: TEXT_GENERATION_MODEL_FILTER,
        capabilityOverrides: {
          "@cf/meta/llama-3.3-8b-instruct": {
            imageInput: false,
            toolCalling: true,
          },
        },
      },
      models,
    );

    const cached = loadCachedCloudflareModels(context, {
      accountId: "acct-a",
      apiKey: "secret-a",
      modelFilter: TEXT_GENERATION_MODEL_FILTER,
      capabilityOverrides: {
        "@cf/meta/llama-3.3-8b-instruct": {
          toolCalling: true,
          imageInput: false,
        },
      },
    });

    assert.deepStrictEqual(cached?.models, models);
  });

  test("returns cloned models so callers cannot mutate the persisted cache", () => {
    const context = createMockContext();
    saveCachedCloudflareModels(
      context,
      {
        accountId: "acct-a",
        apiKey: "secret-a",
        modelFilter: TEXT_GENERATION_MODEL_FILTER,
      },
      [makeModel("uuid-1", "@cf/meta/llama-3.3-8b-instruct")],
    );

    const cached = loadCachedCloudflareModels(context, {
      accountId: "acct-a",
      apiKey: "secret-a",
      modelFilter: TEXT_GENERATION_MODEL_FILTER,
    });
    assert.ok(cached);

    cached.models[0]!.detectedCapabilities!.toolCalling = false;
    cached.models.push(makeModel("uuid-2", "@cf/meta/llama-3.3-70b-instruct"));

    const restored = loadCachedCloudflareModels(context, {
      accountId: "acct-a",
      apiKey: "secret-a",
      modelFilter: TEXT_GENERATION_MODEL_FILTER,
    });

    assert.strictEqual(restored?.models.length, 1);
    assert.strictEqual(restored?.models[0]?.detectedCapabilities?.toolCalling, true);
  });
});
