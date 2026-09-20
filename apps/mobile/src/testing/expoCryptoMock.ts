import * as NodeCrypto from "node:crypto";

export const CryptoDigestAlgorithm = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA384: "SHA-384",
  SHA512: "SHA-512",
} as const;

export const getRandomBytes = (byteCount: number) =>
  new Uint8Array(NodeCrypto.randomBytes(byteCount));
export const getRandomBytesAsync = (byteCount: number) =>
  Promise.resolve(getRandomBytes(byteCount));
export const digest = (algorithm: string, data: Uint8Array) =>
  Promise.resolve(new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer);
