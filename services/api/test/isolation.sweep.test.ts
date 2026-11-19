import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, boot, makePayer, PIN, TEST_DB, type Ctx } from './helpers';

/**
 * Tenant isolation sweep: customer A owns one of everything; customer B (a different, fully valid customer) tries every
 * read and write against A's identifiers. Each attempt must fail without revealing that the object exists, and A's data
 * must be unchanged afterwards.
 */
describe.skipIf(!TEST_DB)('cross-customer isolation sweep', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });
  const id = () => randomBytes(3).toString('hex');
  const key = () => randomBytes(12).toString('hex'); // Idempotency-Key must be 16-64 URL-safe characters

  it('B cannot read, change or act on any of A\'s objects', async () => {
    const a = await makePayer(ctx, `swa${id()}`, 500_000n);
    const b = await makePayer(ctx, `swb${id()}`, 500_000n);
    const third = await makePayer(ctx, `swc${id()}`, 0n);
    const A = (m: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => ctx.http[m](`/api/v1${path}`).set(bearer(a.token)).send(body);
    const B = (m: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => ctx.http[m](`/api/v1${path}`).set(bearer(b.token)).send(body);

    // ── A creates one of everything ──
    const draft = await A('post', '/payments', { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: third.number }, amountMinor: 1_000 }).set('Idempotency-Key', key());
    expect(draft.status).toBe(201);
    const posted = await A('post', '/payments', { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: third.number }, amountMinor: 2_000 }).set('Idempotency-Key', key());
    await A('post', `/payments/${posted.body.id}/authorize`, { pin: PIN });
    const ticket = await A('post', '/support/tickets', { subject: 'Private matter', category: 'GENERAL', message: 'Sensitive details' });
    const dispute = await A('post', '/disputes', { paymentId: posted.body.id, reasonCode: 'UNAUTHORISED', description: 'I did not make this payment' });
    const tpl = await A('post', '/payment-templates', { name: 'Mine', destination: { type: 'ZENTRIX', accountNumber: third.number } });
    const goal = await A('post', '/savings/goals', { name: 'Holiday', targetMinor: 100_000 });
    const req = await A('post', '/payment-requests', { receiveAccountId: a.accountId, payerAccountNumber: third.number, amountMinor: 500 });
    const ben = await A('post', '/beneficiaries', { bankCode: 'ZENTRIX', accountNumber: third.number });
    for (const r of [ticket, dispute, tpl, goal, req]) expect(r.status).toBe(201);

    const balanceBefore = (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: a.ledgerId } })).balanceMinor;
    const nonexistent = '00000000-0000-4000-8000-000000000000';

    // ── B attempts everything. Expected: 404 (or 4xx), never 2xx, and identical to asking for something that does not exist ──
    const attempts: [string, () => Promise<{ status: number; body: unknown }>][] = [
      ['read account', () => B('get', `/accounts/${a.accountId}`)],
      ['statement', () => B('get', `/accounts/${a.accountId}/statement`)],
      ['certificate', () => B('get', `/accounts/${a.accountId}/certificate`)],
      ['QR for account', () => B('get', `/payments-qr/${a.accountId}`)],
      ['read payment', () => B('get', `/payments/${posted.body.id}`)],
      ['receipt', () => B('get', `/payments/${posted.body.id}/receipt`)],
      ['authorize draft', () => B('post', `/payments/${draft.body.id}/authorize`, { pin: PIN })],
      ['cancel draft', () => B('post', `/payments/${draft.body.id}/cancel`)],
      ['pay from A\'s account', () => B('post', '/payments', { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: third.number }, amountMinor: 100 }).set('Idempotency-Key', key())],
      ['pay into A\'s OWN account', () => B('post', '/payments', { sourceAccountId: b.accountId, destination: { type: 'OWN', accountId: a.accountId }, amountMinor: 100 }).set('Idempotency-Key', key())],
      ['read ticket', () => B('get', `/support/tickets/${ticket.body.id}`)],
      ['reply ticket', () => B('post', `/support/tickets/${ticket.body.id}/messages`, { body: 'hello' })],
      ['close ticket', () => B('post', `/support/tickets/${ticket.body.id}/close`)],
      ['read dispute', () => B('get', `/disputes/${dispute.body.id}`)],
      ['dispute A\'s payment', () => B('post', '/disputes', { paymentId: posted.body.id, reasonCode: 'OTHER', description: 'Not mine at all really' })],
      ['delete template', () => B('delete', `/payment-templates/${tpl.body.id}`)],
      ['template on A\'s account', () => B('post', '/payment-templates', { name: 'x1', sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: third.number } })],
      ['contribute to goal', () => B('post', `/savings/goals/${goal.body.id}/contribute`, { accountId: b.accountId, amountMinor: 100, pin: PIN }).set('Idempotency-Key', key())],
      ['receive into A\'s account', () => B('post', '/payment-requests', { receiveAccountId: a.accountId, payerAccountNumber: third.number, amountMinor: 100 })],
      ['pay A\'s request as payer', () => B('post', `/payment-requests/${req.body.id}/pay`, { sourceAccountId: b.accountId }).set('Idempotency-Key', key())],
      ['cancel A\'s request', () => B('post', `/payment-requests/${req.body.id}/cancel`)],
      ['update beneficiary', () => B('put', `/beneficiaries/${ben.body.id}`, { nickname: 'hijack' })],
      ['delete beneficiary', () => B('delete', `/beneficiaries/${ben.body.id}`)],
    ];
    const results: Record<string, number> = {};
    for (const [name, run] of attempts) {
      const r = await run();
      results[name] = r.status;
      expect(r.status, `${name} must be refused`).toBeGreaterThanOrEqual(400);
      expect(r.status, `${name} must not be a server error`).toBeLessThan(500);
      const text = JSON.stringify(r.body);
      expect(text, `${name} must not leak A's identifiers`).not.toContain(a.number);
      expect(text, `${name} must not leak A's content`).not.toMatch(/Private matter|Sensitive details/);
    }

    // Asking about an object that does not exist looks the same as asking about someone else's (no existence oracle).
    const real = await B('get', `/payments/${posted.body.id}`);
    const fake = await B('get', `/payments/${nonexistent}`);
    expect(real.status).toBe(fake.status);
    const mask = (b: unknown) => JSON.stringify(b).replace(/"requestId":"[0-9a-f]+"/g, '"requestId":"R"').replace(/[0-9a-f-]{36}/g, 'X'); // the per-request trace id legitimately differs
    expect(mask(real.body)).toBe(mask(fake.body));
    const realT = await B('get', `/support/tickets/${ticket.body.id}`);
    const fakeT = await B('get', `/support/tickets/${nonexistent}`);
    expect(realT.status).toBe(fakeT.status);

    // ── A's world is exactly as A left it ──
    expect((await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: a.ledgerId } })).balanceMinor).toBe(balanceBefore);
    expect((await ctx.prisma.paymentInstruction.findUniqueOrThrow({ where: { id: draft.body.id } })).status).not.toBe('POSTED');
    expect((await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.body.id } })).status).toBe('OPEN');
    expect((await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.body.id } })).status).toBe('PENDING');
    expect(await ctx.prisma.paymentTemplate.count({ where: { id: tpl.body.id } })).toBe(1);
    expect((await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: ben.body.id } })).nickname).not.toBe('hijack');
    expect(await ctx.prisma.supportMessage.count({ where: { ticketId: ticket.body.id } })).toBe(1);

    // B's own failed probes were recorded as security events for staff to see.
    expect(await ctx.prisma.securityEvent.count({ where: { userId: b.id, kind: 'FORBIDDEN_RESOURCE_ACCESS' } })).toBeGreaterThan(5);
    // And A can still do everything.
    expect((await A('get', `/payments/${posted.body.id}`)).status).toBe(200);
    expect((await A('get', `/support/tickets/${ticket.body.id}`)).status).toBe(200);
    expect(Object.keys(results).length).toBe(attempts.length);
  });
});
