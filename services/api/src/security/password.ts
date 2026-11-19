import { hash, verify } from '@node-rs/argon2';

// Argon2id (algorithm 2). OWASP-recommended minimum: m=19MiB, t=2, p=1.
const OPTS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashSecret = (plain: string): Promise<string> => hash(plain, OPTS);

export async function verifySecret(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** Used to equalise timing when the account does not exist. */
export const DUMMY_HASH_PROMISE = hashSecret('dummy-password-for-timing-equalisation');

/** Returns a customer-safe problem description, or null when acceptable. */
export function passwordProblem(password: string, personal: string[] = []): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password))
    return 'Password must include upper-case, lower-case and a digit';
  const lower = password.toLowerCase();
  if (personal.some((p) => p.length >= 3 && lower.includes(p.toLowerCase()))) return 'Password must not contain your name or username';
  return null;
}

/** App PIN: 4 or 6 digits, not all identical, not a straight run. */
export function pinProblem(pin: string): string | null {
  if (!/^(\d{4}|\d{6})$/.test(pin)) return 'PIN must be 4 or 6 digits';
  if (/^(\d)\1+$/.test(pin)) return 'PIN is too easy to guess';
  const d = [...pin].map(Number);
  const step = (d[1] ?? 0) - (d[0] ?? 0);
  if ((step === 1 || step === -1) && d.every((v, i) => i === 0 || v - (d[i - 1] ?? 0) === step)) return 'PIN is too easy to guess';
  return null;
}
