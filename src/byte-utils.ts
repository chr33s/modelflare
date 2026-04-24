const BASE64_BINARY_CHUNK_SIZE = 0x8000;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function bytesToBase64(value: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";

    for (let index = 0; index < value.length; index += BASE64_BINARY_CHUNK_SIZE) {
      const chunk = value.subarray(index, index + BASE64_BINARY_CHUNK_SIZE);
      binary += Array.from(chunk, (byte) => String.fromCharCode(byte)).join("");
    }

    return btoa(binary);
  }

  return Buffer.from(value).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  return Uint8Array.from(Buffer.from(value, "base64"));
}
