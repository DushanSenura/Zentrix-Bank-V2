import * as OTPAuth from 'otpauth';

const make = (secretBase32: string, label = 'staff') =>
  new OTPAuth.TOTP({
    issuer: 'Zentrix Bank (simulation)',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

export const newTotpSecret = (): string => new OTPAuth.Secret({ size: 20 }).base32;
export const totpUri = (secretBase32: string, label: string): string => make(secretBase32, label).toString();
export const totpNow = (secretBase32: string): string => make(secretBase32).generate();

/** Accepts the current code +/- one 30s step. (Replay of a used code within its window is a known limitation.) */
export function verifyTotp(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return make(secretBase32).validate({ token: code, window: 1 }) !== null;
}
