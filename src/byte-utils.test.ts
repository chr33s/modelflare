import * as assert from "assert";
import { base64ToBytes, bytesToBase64, utf8ByteLength } from "./byte-utils";

suite("byte-utils", () => {
  test("utf8ByteLength counts multi-byte characters", () => {
    assert.strictEqual(utf8ByteLength("hello"), 5);
    assert.strictEqual(utf8ByteLength("😀"), 4);
  });

  test("bytesToBase64 encodes binary data without Node globals", () => {
    const bytes = Uint8Array.from([0, 15, 16, 127, 128, 255]);

    assert.strictEqual(bytesToBase64(bytes), "AA8Qf4D/");
  });

  test("base64ToBytes decodes base64 with surrounding whitespace", () => {
    const decoded = base64ToBytes("  AA8Qf4D/  ");

    assert.deepStrictEqual(Array.from(decoded), [0, 15, 16, 127, 128, 255]);
  });

  test("base64 round-trips arbitrary UTF-8 payloads", () => {
    const source = new TextEncoder().encode("Cloudflare web worker");
    const roundTrip = base64ToBytes(bytesToBase64(source));

    assert.deepStrictEqual(Array.from(roundTrip), Array.from(source));
  });
});
