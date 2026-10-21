import { randomInt } from 'node:crypto';

// No 0/O, 1/I/L: people read these codes out over the phone and type them on phones.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Random code, e.g. a temporary password an admin reads to a customer. */
export function generateCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function generatePaymentReference(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  let rand = '';
  for (let i = 0; i < 8; i++) rand += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `YW-${stamp}-${rand}`;
}

/**
 * Normalizes Nigerian mobile numbers to E.164 (+234XXXXXXXXXX).
 * Accepts 0803..., 803..., 234803..., +234 803 ...
 * Returns null if the input isn't a plausible Nigerian mobile number.
 */
export function normalizeNigerianPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let national: string;
  if (digits.startsWith('234')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  if (!/^[789][01]\d{8}$/.test(national)) return null;
  return `+234${national}`;
}
