import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { addMonths, simpleInterest } from '../src/modules/deposits/interest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const key = () => randomBytes(16).toString('hex');

describe.skipIf(!TEST_DB)('fixed deposits (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  let deposits: DepositsService;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;

  beforeAll(async () => { ctx = await boot(); ledger = ctx.app.get(LedgerService); deposits = ctx.app.get(DepositsService); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const open = (p: Payer, body: object, k = key()) =>
    ctx.http.post('/api/v1/fixed-deposits').set(bearer(p.token)).set('Idempotency-Key', k).send({ fundingAccountId: p.accountId, amountMinor: 1_000_000, termMonths: 12, renewal: 'PAYOUT', pin: PIN, ...body });
  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;
  const accBal = (p: Payer) => bal(p.ledgerId);
  const fdRow = (id: string) => ctx.prisma.fixedDeposit.findUniqueOrThrow({ where: { id } });
  /** Pretend time has passed: pull the deposit's dates back so it is due `daysAgo` days ago. */
  const age = async (id: string, daysAgo: number) => {
    const fd = await fdRow(id);
    const shift = daysAgo * 86_400_000;
    await ctx.prisma.fixedDeposit.update({ where: { id }, data: { startDate: new Date(fd.startDate.getTime() - 400 * 86_400_000), maturityDate: new Date(Date.now() - shift) } });
  };

  it('Scenario D: choose term -> confirm with PIN -> ledger posting -> deposit active; the maturity job pays it out', async () => {
    const c = await makePayer(ctx, nm('fd'), 5_000_000n);
    expect((await ctx.http.get('/api/v1/fixed-deposits/rates').set(bearer(c.token))).body.items.map((r: { termMonths: number }) => r.termMonths)).toContain(12);

    const calc = (await ctx.http.get('/api/v1/fixed-deposits/calculate?amountMinor=1000000&termMonths=12').set(bearer(c.token))).body;
    expect(calc).toMatchObject({ rateBps: 900, interestMinor: 90_000, maturityValueMinor: 1_090_000 });

    const r = await open(c, { renewal: 'PAYOUT' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'ACTIVE', principalMinor: 1_000_000, rateBps: 900, termMonths: 12, interestAtMaturityMinor: 90_000, maturityValueMinor: 1_090_000 });
    expect(await accBal(c)).toBe(4_000_000n); // funding account debited by the ledger
    const fd = await fdRow(r.body.id);
    expect(await bal(fd.ledgerAccountId)).toBe(1_000_000n);
    const j = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { reference: `FDOPEN-${fd.reference}` }, include: { postings: true } });
    expect(j.postings).toHaveLength(2);
    expect(new Date(r.body.maturityDate).getTime()).toBeCloseTo(addMonths(new Date(r.body.startDate), 12).getTime(), -3);

    const list = (await ctx.http.get('/api/v1/fixed-deposits').set(bearer(c.token))).body;
    expect(list).toMatchObject({ lockedMinor: 1_000_000, interestToComeMinor: 90_000 });
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.some((x: { title: string }) => x.title === 'Fixed deposit opened')).toBe(true);

    // not yet due: nothing happens
    await deposits.runDue(new Date());
    expect((await fdRow(r.body.id)).status).toBe('ACTIVE');
    // maturity processed by the BACKGROUND JOB, not by opening a screen
    await age(r.body.id, 1);
    const out = await deposits.runDue(new Date());
    expect(out.matured).toBeGreaterThanOrEqual(1);
    const done = await fdRow(r.body.id);
    expect(done.status).toBe('MATURED');
    expect(await accBal(c)).toBe(4_000_000n + 1_090_000n); // principal + interest back in the account
    expect(await bal(done.ledgerAccountId)).toBe(0n);
    expect((await deposits.runDue(new Date())).matured).toBe(0); // nothing left to pay
    expect(await accBal(c)).toBe(5_090_000n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('validation: term, minimum, PIN, funds, ownership; closed terms', async () => {
    const c = await makePayer(ctx, nm('fdv'), 2_000_000n);
    expect((await open(c, { termMonths: 34 })).status).toBe(400); // V1: only whole years beyond 12 months
    expect((await open(c, { termMonths: 2 })).status).toBe(400);
    expect((await open(c, { amountMinor: 999_999 })).status).toBe(422); // minimum LKR 10,000
    expect((await open(c, { pin: '000000' })).status).toBe(401);
    expect((await open(c, { amountMinor: 3_000_000 })).status).toBe(422); // insufficient funds
    expect((await ctx.http.post('/api/v1/fixed-deposits').set(bearer(c.token)).send({ fundingAccountId: c.accountId, amountMinor: 1_000_000, termMonths: 12, renewal: 'PAYOUT', pin: PIN })).status).toBe(400); // key required
    expect((await open(c, { renewal: 'FOREVER' })).status).toBe(400);
    expect((await open(c, { feeMinor: 1 })).status).toBe(400); // strict body
    const other = await makePayer(ctx, nm('fdv2'), 0n);
    expect((await open(c, { fundingAccountId: other.accountId })).status).toBe(404);
    expect(await accBal(c)).toBe(2_000_000n); // every refusal left the money alone
    const frozen = await makePayer(ctx, nm('fdv3'), 2_000_000n);
    await ctx.prisma.account.update({ where: { id: frozen.accountId }, data: { status: 'FROZEN' } });
    expect((await open(frozen, {})).status).toBe(409);
  });

  it('idempotency: the same key sent concurrently opens exactly one deposit; a different body is refused', async () => {
    const c = await makePayer(ctx, nm('fdi'), 3_000_000n);
    const k = key();
    const rs = await Promise.all(Array.from({ length: 4 }, () => open(c, {}, k)));
    expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await ctx.prisma.fixedDeposit.count({ where: { customerId: c.id } })).toBe(1);
    expect(await accBal(c)).toBe(2_000_000n); // debited once
    expect((await open(c, { amountMinor: 1_100_000 }, k)).status).toBe(422);
    const replay = await open(c, { pin: PIN }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('maturity: renew WITH interest compounds the principal; running twice never pays twice', async () => {
    const c = await makePayer(ctx, nm('fdw'), 2_000_000n);
    const r = await open(c, { renewal: 'WITH_INTEREST', termMonths: 12 });
    const fd0 = await fdRow(r.body.id);
    await age(r.body.id, 1);
    const before = await fdRow(r.body.id);
    const runs = await Promise.all([deposits.runDue(new Date()), deposits.runDue(new Date()), deposits.runDue(new Date())]); // 3 workers
    expect(runs.reduce((s, x) => s + x.renewed, 0)).toBe(1);
    const fd = await fdRow(r.body.id);
    expect(fd.principalMinor).toBe(1_090_000n); // interest earns interest
    expect(fd.renewalCount).toBe(1);
    expect(fd.status).toBe('ACTIVE');
    expect(fd.maturityDate.getTime()).toBe(addMonths(before.maturityDate, 12).getTime());
    expect(await bal(fd.ledgerAccountId)).toBe(1_090_000n);
    expect(await accBal(c)).toBe(1_000_000n); // account untouched: interest stayed in the deposit
    expect(await ctx.prisma.fixedDepositRenewal.count({ where: { fixedDepositId: fd.id } })).toBe(1);
    expect((await ctx.http.get(`/api/v1/fixed-deposits/${fd.id}`).set(bearer(c.token))).body.renewals).toHaveLength(1);
    await deposits.runDue(new Date());
    expect((await fdRow(fd.id)).renewalCount).toBe(1);
    expect(fd0.reference).toBeTruthy();
  });

  it('maturity: renew WITHOUT interest pays the interest out and renews only the principal', async () => {
    const c = await makePayer(ctx, nm('fdo'), 2_000_000n);
    const r = await open(c, { renewal: 'WITHOUT_INTEREST', termMonths: 6 });
    await age(r.body.id, 1);
    await deposits.runDue(new Date());
    const fd = await fdRow(r.body.id);
    const interest = simpleInterest(1_000_000n, 800, 6);
    expect(fd.principalMinor).toBe(1_000_000n);
    expect(fd.renewalCount).toBe(1);
    expect(await accBal(c)).toBe(1_000_000n + interest);
    expect(await bal(fd.ledgerAccountId)).toBe(1_000_000n);
  });

  it('catch-up: after downtime spanning several terms every missed maturity is processed once, in order', async () => {
    const c = await makePayer(ctx, nm('fdc'), 2_000_000n);
    const r = await open(c, { renewal: 'WITH_INTEREST', termMonths: 3 });
    const fd0 = await fdRow(r.body.id);
    await ctx.prisma.fixedDeposit.update({ where: { id: fd0.id }, data: { maturityDate: addMonths(new Date(), -8) } }); // ~2.7 terms overdue
    await deposits.runDue(new Date());
    const fd = await fdRow(fd0.id);
    expect(fd.renewalCount).toBe(3);
    expect(fd.maturityDate.getTime()).toBeGreaterThan(Date.now());
    let p = 1_000_000n;
    for (let i = 0; i < 3; i++) p += simpleInterest(p, 750, 3);
    expect(fd.principalMinor).toBe(p);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('a deposit whose funding account is closed is flagged, not looped on, and others still mature', async () => {
    const bad = await makePayer(ctx, nm('fdbad'), 2_000_000n);
    const good = await makePayer(ctx, nm('fdgood'), 2_000_000n);
    const b = await open(bad, { renewal: 'PAYOUT' });
    const g = await open(good, { renewal: 'PAYOUT' });
    await ctx.prisma.account.update({ where: { id: bad.accountId }, data: { status: 'CLOSED' } });
    await age(b.body.id, 2);
    await age(g.body.id, 1);
    const out = await deposits.runDue(new Date());
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect((await fdRow(b.body.id)).status).toBe('ACTIVE'); // stays for staff attention
    expect((await fdRow(g.body.id)).status).toBe('MATURED');
  });

  it('early closure: staff-reviewed, penalty applied, nothing moves until approval', async () => {
    const c = await makePayer(ctx, nm('fde'), 2_000_000n);
    const admin = await makeStaff(ctx, nm('bankadm'), 'BANK_ADMIN');
    const cardOfficer = await makeStaff(ctx, nm('cardoffx'), 'CARD_OFFICER');
    const r = await open(c, { renewal: 'WITH_INTEREST', termMonths: 12 });
    await ctx.prisma.fixedDeposit.update({ where: { id: r.body.id }, data: { startDate: new Date(Date.now() - 365 * 86_400_000) } }); // held a year, not matured (maturity is in the future)

    const req = await ctx.http.post(`/api/v1/fixed-deposits/${r.body.id}/closure-request`).set(bearer(c.token)).send({ reason: 'Need cash' });
    expect(req.status).toBe(201);
    expect(req.body.estimate).toMatchObject({ interestMinor: 60_000, penaltyMinor: 30_000, payoutMinor: 1_060_000 }); // 9% - 3% penalty
    expect((await ctx.http.post(`/api/v1/fixed-deposits/${r.body.id}/closure-request`).set(bearer(c.token)).send({})).status).toBe(409);
    expect((await fdRow(r.body.id)).status).toBe('ACTIVE');
    expect(await accBal(c)).toBe(1_000_000n); // nothing has moved
    expect((await ctx.http.get(`/api/v1/fixed-deposits/${r.body.id}`).set(bearer(c.token))).body.closureRequested).toBe(true);

    const dec = (token: string, body: object) => ctx.http.post(`/api/v1/admin/fixed-deposit-closures/${req.body.id}/decision`).set(bearer(token)).send(body);
    expect((await dec(cardOfficer.token, { decision: 'APPROVE' })).status).toBe(403);
    expect((await ctx.http.get('/api/v1/admin/fixed-deposit-closures').set(bearer(admin.token))).body.items.some((i: { id: string }) => i.id === req.body.id)).toBe(true);
    expect((await dec(admin.token, { decision: 'REJECT' })).status).toBe(400);
    const ok = await dec(admin.token, { decision: 'APPROVE' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'APPROVED', payoutMinor: 1_060_000, penaltyMinor: 30_000 });
    expect((await fdRow(r.body.id)).status).toBe('CLOSED');
    expect(await accBal(c)).toBe(1_000_000n + 1_060_000n);
    expect(await bal((await fdRow(r.body.id)).ledgerAccountId)).toBe(0n);
    expect((await dec(admin.token, { decision: 'APPROVE' })).status).toBe(409);
    expect((await ctx.http.post(`/api/v1/fixed-deposits/${r.body.id}/closure-request`).set(bearer(c.token)).send({})).status).toBe(409); // already closed
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: r.body.id, action: 'fd.closure_approved', actorId: admin.id } })).toBe(1);
    expect((await ledger.reconcile()).ok).toBe(true);

    const r2 = await open(c, {});
    const q2 = await ctx.http.post(`/api/v1/fixed-deposits/${r2.body.id}/closure-request`).set(bearer(c.token)).send({});
    const rej = await ctx.http.post(`/api/v1/admin/fixed-deposit-closures/${q2.body.id}/decision`).set(bearer(admin.token)).send({ decision: 'REJECT', reason: 'Within lock-in' });
    expect(rej.body.status).toBe('REJECTED');
    expect((await fdRow(r2.body.id)).status).toBe('ACTIVE');
  });

  it('rate card is staff-managed: permissions, effect on new deposits, deactivating a term', async () => {
    const c = await makePayer(ctx, nm('fdr'), 5_000_000n);
    const admin = await makeStaff(ctx, nm('bankadm'), 'BANK_ADMIN');
    const officer = await makeStaff(ctx, nm('cardoffy'), 'CARD_OFFICER');
    const put = (token: string, body: object) => ctx.http.put('/api/v1/admin/fixed-deposit-rates').set(bearer(token)).send(body);
    expect((await put(officer.token, { termMonths: 12, rateBps: 1500 })).status).toBe(403);
    expect((await put(admin.token, { termMonths: 34, rateBps: 1500 })).status).toBe(400);
    try {
      expect((await put(admin.token, { termMonths: 12, rateBps: 1000 })).body.rateBps).toBe(1000);
      expect((await open(c, { termMonths: 12 })).body.rateBps).toBe(1000);
      expect((await put(admin.token, { termMonths: 12, rateBps: 900, active: false })).status).toBe(200);
      expect((await open(c, { termMonths: 12 })).status).toBe(404); // term withdrawn
      expect((await ctx.http.get('/api/v1/fixed-deposits/rates').set(bearer(c.token))).body.items.some((r: { termMonths: number }) => r.termMonths === 12)).toBe(false);
    } finally {
      await put(admin.token, { termMonths: 12, rateBps: 900, active: true });
    }
    expect((await open(c, { termMonths: 12 })).body.rateBps).toBe(900);
  });

  it('isolation: other customers cannot see or request closure of a deposit', async () => {
    const a = await makePayer(ctx, nm('fdia'), 2_000_000n);
    const b = await makePayer(ctx, nm('fdib'), 0n);
    const r = await open(a, {});
    expect((await ctx.http.get(`/api/v1/fixed-deposits/${r.body.id}`).set(bearer(b.token))).status).toBe(404);
    expect((await ctx.http.post(`/api/v1/fixed-deposits/${r.body.id}/closure-request`).set(bearer(b.token)).send({})).status).toBe(404);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: b.id } })).toBe(2);
    expect((await ctx.http.get('/api/v1/fixed-deposits').set(bearer(b.token))).body.items).toHaveLength(0);
    expect((await ctx.http.get('/api/v1/admin/fixed-deposits').set(bearer(a.token))).status).toBe(403);
  });

  it('ledger stays reconciled after everything', async () => {
    const r = await ledger.reconcile();
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
