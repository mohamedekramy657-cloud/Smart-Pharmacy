import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { config } from '../config/config';

export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();
export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function hmacHex(data: string, secret = config().APP_SECRET): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Keyed hash so IPs can be correlated for abuse detection without storing raw addresses. */
export const hashIp = (ip: string | undefined): string | undefined => (ip ? hmacHex(`ip:${ip}`).slice(0, 32) : undefined);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
export function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** AES-256-GCM for secrets that must be recoverable (webhook HMAC secrets, TOTP seeds). */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(config().DATA_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const key = Buffer.from(config().DATA_ENCRYPTION_KEY, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Deterministic JSON for request hashing (key order independent). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
