import crypto from 'crypto';

function getServerSecret(): string {
  return (
    process.env.GAME_SERVER_SECRET ||
    'hack-the-system-reading-escape-room-server-key-2026-v1'
  );
}

function getAesKey(): Buffer {
  return crypto.createHash('sha256').update(getServerSecret()).digest();
}

export function encryptJson<T>(data: T): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAesKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptJson<T>(payload: string): T {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Format data terenkripsi tidak valid');
  }
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getAesKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function hashSecret(value: string, context: string): string {
  return crypto
    .createHmac('sha256', getServerSecret())
    .update(`${context}:${value}`)
    .digest('hex');
}

export function verifySecretHash(value: string, context: string, expectedHash: string): boolean {
  const actual = hashSecret(value, context);
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function deriveGateToken(sessionId: string): string {
  return crypto
    .createHmac('sha256', getServerSecret())
    .update(`server-gate:${sessionId}`)
    .digest('hex');
}

export function randomNonce(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function randomGroupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
