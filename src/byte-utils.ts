const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function getBase64AlphabetIndex(character: string): number {
  const index = BASE64_ALPHABET.indexOf(character);
  if (index >= 0) {
    return index;
  }

  throw new Error(`Invalid base64 character: ${character}`);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function bytesToBase64(value: Uint8Array): string {
  let encoded = "";

  for (let index = 0; index < value.length; index += 3) {
    const firstByte = value[index] ?? 0;
    const secondByte = value[index + 1];
    const thirdByte = value[index + 2];
    const combined = (firstByte << 16) | ((secondByte ?? 0) << 8) | (thirdByte ?? 0);

    encoded += BASE64_ALPHABET[(combined >> 18) & 0x3f] ?? "";
    encoded += BASE64_ALPHABET[(combined >> 12) & 0x3f] ?? "";
    encoded += secondByte === undefined ? "=" : (BASE64_ALPHABET[(combined >> 6) & 0x3f] ?? "");
    encoded += thirdByte === undefined ? "=" : (BASE64_ALPHABET[combined & 0x3f] ?? "");
  }

  return encoded;
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, "");
  if (normalized.length === 0) {
    return new Uint8Array();
  }

  if (normalized.length % 4 !== 0) {
    throw new Error("Invalid base64 string length");
  }

  const paddingCount = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const outputLength = Math.floor((normalized.length * 3) / 4) - paddingCount;
  const bytes = new Uint8Array(outputLength);
  let writeIndex = 0;

  for (let index = 0; index < normalized.length; index += 4) {
    const firstCharacter = normalized[index];
    const secondCharacter = normalized[index + 1];
    const thirdCharacter = normalized[index + 2];
    const fourthCharacter = normalized[index + 3];
    if (!firstCharacter || !secondCharacter || !thirdCharacter || !fourthCharacter) {
      throw new Error("Invalid base64 quartet");
    }

    const combined =
      (getBase64AlphabetIndex(firstCharacter) << 18) |
      (getBase64AlphabetIndex(secondCharacter) << 12) |
      ((thirdCharacter === "=" ? 0 : getBase64AlphabetIndex(thirdCharacter)) << 6) |
      (fourthCharacter === "=" ? 0 : getBase64AlphabetIndex(fourthCharacter));

    if (writeIndex < outputLength) {
      bytes[writeIndex] = (combined >> 16) & 0xff;
      writeIndex += 1;
    }

    if (writeIndex < outputLength) {
      bytes[writeIndex] = (combined >> 8) & 0xff;
      writeIndex += 1;
    }

    if (writeIndex < outputLength) {
      bytes[writeIndex] = combined & 0xff;
      writeIndex += 1;
    }
  }

  return bytes;
}
