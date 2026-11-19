import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from './prisma.service';

const TTL_MS = 24 * 3_600_000;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Runs `run` at most once per (user, scope, Idempotency-Key). The key record, the business change and the stored
 * response commit in ONE transaction, so a crash can never leave a half-recorded request. Repeats with the same body
 * replay the original response; the same key with a different body is refused; concurrent duplicates wait on the unique
 * index and then replay.
 *
 * `precheck` (optional) runs before the transaction on first attempts only (validation, PIN) - a replay skips it, so a
 * client that lost the response never needs to re-authenticate to learn the outcome.
 */
export async function withIdempotency<T>(
  prisma: PrismaService,
  o: { userId: string; scope: string; key: string | undefined; body: unknown; precheck?: () => Promise<void>; run: (tx: Prisma.TransactionClient) => Promise<T> },
): Promise<{ result: T; replayed: boolean }> {
  if (!o.key) throw new BadRequestException({ code: 'idempotency_key_required', message: 'Idempotency-Key header is required' });
  if (!KEY.test(o.key)) throw new BadRequestException({ code: 'idempotency_key_invalid', message: 'Idempotency-Key must be 16-64 URL-safe characters' });
  const requestHash = createHash('sha256').update(stable(o.body)).digest('hex');
  const id = { userId_scope_key: { userId: o.userId, scope: o.scope, key: o.key } };

  const replay = async (): Promise<{ result: T; replayed: true } | null> => {
    const rec = await prisma.idempotencyRecord.findUnique({ where: id });
    if (!rec) return null;
    if (rec.requestHash !== requestHash) throw new UnprocessableEntityException({ code: 'idempotency_key_reused', message: 'That Idempotency-Key was already used with a different request' });
    if (!rec.responseBody) throw new ConflictException({ code: 'request_in_progress', message: 'This request is still being processed' });
    return { result: rec.responseBody as unknown as T, replayed: true };
  };

  const existing = await replay();
  if (existing) return existing;
  if (o.precheck) await o.precheck();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.idempotencyRecord.create({ data: { key: o.key!, userId: o.userId, scope: o.scope, requestHash, expiresAt: new Date(Date.now() + TTL_MS) } });
        const result = await o.run(tx);
        await tx.idempotencyRecord.update({ where: id, data: { responseStatus: 201, responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue } });
        return { result, replayed: false };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
}
