import * as assert from "assert";
import { normalizeApiKey, getNoModelsFoundMessage } from "./extension";

suite("extension", () => {
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
});
