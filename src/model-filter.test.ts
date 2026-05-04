import * as assert from "assert";
import {
  ALL_MODEL_FILTER,
  getAiGatewayModelFilter,
  LATEST_MODEL_FILTER,
  LATEST_STABLE_MODEL_FILTER,
  normalizeCloudflareModelFilter,
  TEXT_GENERATION_MODEL_FILTER,
} from "./model-filter";

suite("model-filter", () => {
  test("normalizes configured filter values to canonical slugs", () => {
    assert.strictEqual(normalizeCloudflareModelFilter(undefined), TEXT_GENERATION_MODEL_FILTER);
    assert.strictEqual(normalizeCloudflareModelFilter(" all "), ALL_MODEL_FILTER);
    assert.strictEqual(normalizeCloudflareModelFilter(" latest "), LATEST_MODEL_FILTER);
    assert.strictEqual(
      normalizeCloudflareModelFilter(" latest stable "),
      LATEST_STABLE_MODEL_FILTER,
    );
    assert.strictEqual(
      normalizeCloudflareModelFilter(" Latest Stable "),
      LATEST_STABLE_MODEL_FILTER,
    );
    assert.strictEqual(
      normalizeCloudflareModelFilter(" text-generation "),
      TEXT_GENERATION_MODEL_FILTER,
    );
    assert.strictEqual(
      normalizeCloudflareModelFilter(" Text Generation "),
      TEXT_GENERATION_MODEL_FILTER,
    );
    assert.strictEqual(normalizeCloudflareModelFilter(" Text Embeddings "), "text-embeddings");
  });

  test("maps Workers AI latest filters to text generation for AI Gateway discovery", () => {
    assert.strictEqual(getAiGatewayModelFilter(ALL_MODEL_FILTER), ALL_MODEL_FILTER);
    assert.strictEqual(getAiGatewayModelFilter(LATEST_MODEL_FILTER), TEXT_GENERATION_MODEL_FILTER);
    assert.strictEqual(
      getAiGatewayModelFilter(LATEST_STABLE_MODEL_FILTER),
      TEXT_GENERATION_MODEL_FILTER,
    );
    assert.strictEqual(
      getAiGatewayModelFilter(TEXT_GENERATION_MODEL_FILTER),
      TEXT_GENERATION_MODEL_FILTER,
    );
  });
});
