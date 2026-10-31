import { readCsSetting } from "./environment";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

const SECRET_PREFIX = "xcs:secret:";
const VERSION_PREFIX = `${SECRET_PREFIX}v1:`;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const failure = () => new Error("Protected secret is unavailable.");

export function readProtectedSecret(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_SECRET_FILE_BYTES) throw failure();
    const bytes = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SECRET_FILE_BYTES) throw failure();
    return bytes.subarray(0, length).toString("utf8");
  } catch {
    throw failure();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface SecretCodec {
  sealSecret(value: string, context: string): string;
  openSecret(value: string, context: string): string;
}

export function createSecretCodec(key: Uint8Array | null): SecretCodec {
  if (key !== null && key.byteLength !== 32) throw failure();
  const encryptionKey = key === null ? null : Buffer.from(key);
  return {
    sealSecret(value, context) {
      if (encryptionKey === null) {
        if (value.startsWith(SECRET_PREFIX)) throw failure();
        return value;
      }
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
        cipher.setAAD(Buffer.from(`${VERSION_PREFIX}${context}`, "utf8"));
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return VERSION_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
      } catch {
        throw failure();
      }
    },
    openSecret(value, context) {
      if (!value.startsWith(SECRET_PREFIX)) return value;
      try {
        if (!encryptionKey || !value.startsWith(VERSION_PREFIX)) throw failure();
        const encoded = value.slice(VERSION_PREFIX.length);
        const packed = Buffer.from(encoded, "base64");
        if (packed.length < 28 || packed.toString("base64") !== encoded) throw failure();
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, packed.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${VERSION_PREFIX}${context}`, "utf8"));
        decipher.setAuthTag(packed.subarray(12, 28));
        return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        throw failure();
      }
    },
  };
}

export function loadTokenKey(env: Record<string, string | undefined> = process.env): Uint8Array | null {
  const explicitPath = readCsSetting(env, "CS_TOKEN_KEY_FILE");
  const path = explicitPath || (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "token-encryption-key") : null);
  if (!path) return null;
  // A configured credential directory means the credential is required. Missing
  // key files must not silently downgrade writes to plaintext.
  const text = readProtectedSecret(path).trim();
  const key = Buffer.from(text, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== text) throw failure();
  return key;
}

let defaultCodec: SecretCodec | undefined;
function configuredCodec(): SecretCodec {
  return defaultCodec ??= createSecretCodec(loadTokenKey());
}

export const sealSecret = (value: string, context: string): string => configuredCodec().sealSecret(value, context);
export const openSecret = (value: string, context: string): string => configuredCodec().openSecret(value, context);
