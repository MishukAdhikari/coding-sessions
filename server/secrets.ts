import { readCsSetting } from "./environment";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

const VERSION_PREFIX = "cs:secret:v1:";
// Values sealed by earlier releases carry one extra leading letter; they still open.
const SEALED_PATTERN = /^x?cs:secret:/;
const VERSION_PATTERN = /^x?cs:secret:v1:/;

/** True if the value is an encrypted v1 secret. */
export function isSealedSecret(value: string): boolean {
  return VERSION_PATTERN.test(value);
}
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const failure = () => new Error("Protected secret is unavailable.");

export interface ProtectedSecretOptions {
  /** The file came from systemd's private $CREDENTIALS_DIRECTORY. */
  systemdCredential?: boolean;
  rootUid?: number;
}

export function readProtectedSecret(path: string, options: ProtectedSecretOptions = {}): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const ownerOnly = (stat.mode & 0o077) === 0;
    // systemd 254+ hands LoadCredential files over as root-owned 0440, readable by
    // the unit through an ACL in a directory private to it. Accept exactly that.
    const systemdShape = options.systemdCredential === true
      && stat.uid === (options.rootUid ?? 0) && (stat.mode & 0o037) === 0;
    if (!stat.isFile() || !(ownerOnly || systemdShape) || stat.size > MAX_SECRET_FILE_BYTES) throw failure();
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
        if (SEALED_PATTERN.test(value)) throw failure();
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
      if (!SEALED_PATTERN.test(value)) return value;
      try {
        const prefix = VERSION_PATTERN.exec(value)?.[0];
        if (!encryptionKey || !prefix) throw failure();
        const encoded = value.slice(prefix.length);
        const packed = Buffer.from(encoded, "base64");
        if (packed.length < 28 || packed.toString("base64") !== encoded) throw failure();
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, packed.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${prefix}${context}`, "utf8"));
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
  const text = readProtectedSecret(path, { systemdCredential: !explicitPath }).trim();
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
