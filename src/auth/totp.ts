import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

export function totpCodeFor(secret: string, atUnixSeconds: number): string {
  return hotp(secret, Math.floor(atUnixSeconds / 30));
}

/**
 * Return the time-step a code matches within ±1 window (for clock skew), or null.
 * Callers that enforce single-use compare the returned step against the last
 * accepted one so a code cannot be replayed within its window.
 */
export function verifyTotpStep(secret: string, code: string, atUnixSeconds: number): number | null {
  const step = Math.floor(atUnixSeconds / 30);
  for (const c of [step - 1, step, step + 1]) {
    if (hotp(secret, c) === code) return c;
  }
  return null;
}

/** Verify with ±1 time-step (30s) tolerance for clock skew. */
export function verifyTotp(secret: string, code: string, atUnixSeconds: number): boolean {
  return verifyTotpStep(secret, code, atUnixSeconds) !== null;
}

export function totpUri(secret: string, label: string, issuer = 'Bookkeeping'): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
