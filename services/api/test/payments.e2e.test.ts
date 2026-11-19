import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { addInterval, PaymentsService } from '../src/modules/payments/payments.service';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makeCustomer, makeLedgerAccount, makeStaff, TEST_DB, type Ctx } from './helpers';

const JOB_TOKEN = 'j'.repeat(40);
process.env.INTERNAL_JOB_TOKEN = JOB_TOKEN;
const PIN = '482916';
const key = () => randomBytes(16).toString('hex');

describe.skipIf(!TEST_DB)('payments (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  let payments: PaymentsService;
  let n = 0;
  const runId = randomBytes(3).toString('hex'); // references/usernames must be unique across runs (the test DB persists)
  const nm = (p: string) => `${p}${n++}${runId}`;

  beforeAll(async () => { ctx = await boot(); ledger = ctx.app.get(LedgerService); payments = ctx.app.get(PaymentsService); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  async function payer(name: string, balance: bigint) {
    const c = await makeCustomer(ctx, name);
    expect((await ctx.http.put('/api/v1/me/pin').set(bearer(c.token)).send({ pin: PIN })).status).toBe(204);
    const acc = await makeLedgerAccount(ctx, c.id, balance);
    return { ...c, acc, accountId: acc.id, number: acc.accountNumber, ledgerId: acc.ledgerAccount!.id };
  }
  type P = Awaited<ReturnType<typeof payer>>;
  const bal = async (p: P) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: p.ledgerId } })).balanceMinor;
  const create = (p: P, body: object, k = key()) => ctx.http.post('/api/v1/payments').set(bearer(p.token)).set('Idempotency-Key', k).send(body);
  const authorize = (p: P, id: string, pin = PIN) => ctx.http.post(`/api/v1/payments/${id}/authorize`).set(bearer(p.token)).send({ pin });
  const toZentrix = (from: P, to: P, amountMinor: number, extra: object = {}) => ({ sourceAccountId: from.accountId, destination: { type: 'ZENTRIX', accountNumber: to.number }, amountMinor, ...extra });
  const fullName = async (p: P) => (await ctx.prisma.customerProfile.findUniqueOrThrow({ where: { userId: p.id } })).fullName;
  const journals = (paymentId: string) => ctx.prisma.ledgerJournal.count({ where: { paymentId } });
  const sysBal = async (code: string) => (await ctx.prisma.ledgerAccount.findUnique({ where: { code } }))?.balanceMinor ?? 0n;

  it('Scenario B: review -> PIN -> ledger posting -> receipt -> notifications (internal transfer)', async () => {
    const a = await payer(nm('sendera'), 1_000_000n);
    const b = await payer(nm('recvb'), 0n);
    const draft = await create(a, toZentrix(a, b, 250_000, { note: 'Rent' }));
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'AWAITING_AUTHORIZATION', amountMinor: 250_000, feeMinor: 0, totalMinor: 250_000, kind: 'INTERNAL_TRANSFER' });
    expect(draft.body.recipient.name).toBe(await fullName(b)); // resolved by the server
    expect(await bal(a)).toBe(1_000_000n); // a draft moves NO money
    expect(await journals(draft.body.id)).toBe(0);

    const done = await authorize(a, draft.body.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'POSTED', reference: draft.body.reference });
    expect(done.body.postedAt).toBeTruthy();
    expect(await bal(a)).toBe(750_000n);
    expect(await bal(b)).toBe(250_000n);

    const j = await ctx.prisma.ledgerJournal.findFirstOrThrow({ where: { paymentId: draft.body.id }, include: { postings: true } });
    expect(j.reference).toBe(draft.body.reference);
    expect(j.postings).toHaveLength(2);
    const sum = (d: string) => j.postings.filter((p) => p.direction === d).reduce((s, p) => s + p.amountMinor, 0n);
    expect(sum('DEBIT')).toBe(sum('CREDIT'));

    expect((await ctx.http.get(`/api/v1/payments/${draft.body.id}`).set(bearer(a.token))).body.status).toBe('POSTED'); // receipt
    const hist = (acc: P) => ctx.http.get(`/api/v1/accounts/${acc.accountId}/transactions`).set(bearer(acc.token));
    expect((await hist(a)).body.items[0]).toMatchObject({ kind: 'INTERNAL_TRANSFER', amountMinor: -250_000, reference: draft.body.reference });
    expect((await hist(b)).body.items[0]).toMatchObject({ amountMinor: 250_000 });

    expect(await ctx.prisma.auditLog.count({ where: { subjectId: draft.body.id, action: { in: ['payment.authorized', 'payment.posted'] } } })).toBe(2);
    await relayOutboxBatch(ctx.prisma as never, 500); // what the worker does
    const na = (await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body;
    const nb = (await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body;
    expect(na.items.some((x: { title: string }) => x.title === 'Payment sent')).toBe(true);
    expect(nb.items.some((x: { title: string; body: string }) => x.title === 'Money received' && x.body.includes(draft.body.reference))).toBe(true);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('server owns fee/status/balance: client-supplied values are rejected; wrong PIN moves nothing', async () => {
    const a = await payer(nm('guard'), 500_000n);
    const b = await payer(nm('guardb'), 0n);
    expect((await create(a, { ...toZentrix(a, b, 1000), feeMinor: 0 })).status).toBe(400);
    expect((await create(a, { ...toZentrix(a, b, 1000), status: 'POSTED' })).status).toBe(400);
    expect((await create(a, toZentrix(a, b, 0))).status).toBe(400);
    expect((await create(a, toZentrix(a, b, 12.5))).status).toBe(400);
    const d = await create(a, toZentrix(a, b, 1000));
    expect((await authorize(a, d.body.id, '000000')).status).toBe(401);
    expect((await ctx.http.get(`/api/v1/payments/${d.body.id}`).set(bearer(a.token))).body.status).toBe('AWAITING_AUTHORIZATION');
    expect(await bal(a)).toBe(500_000n);
    expect((await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(a.token)).send({ pin: PIN, amountMinor: 1 })).status).toBe(400); // strict body
  });

  it('five wrong PINs on a payment sign the customer out everywhere', async () => {
    const a = await payer(nm('lock'), 500_000n);
    const b = await payer(nm('lockb'), 0n);
    const d = await create(a, toZentrix(a, b, 1000));
    for (let i = 0; i < 4; i++) expect((await authorize(a, d.body.id, '111222')).status).toBe(401);
    expect((await authorize(a, d.body.id, '111222')).status).toBe(401);
    expect((await ctx.http.get('/api/v1/me').set(bearer(a.token))).status).toBe(401);
    expect(await bal(a)).toBe(500_000n);
  });

  it('interbank transfer: the bank computes a flat fee, posts to settlement and fee income', async () => {
    const a = await payer(nm('ib'), 1_000_000n);
    const feeBefore = await sysBal('SYS-FEE-INCOME-LKR');
    const ibBefore = await sysBal('SYS-INTERBANK-LKR');
    const body = { sourceAccountId: a.accountId, destination: { type: 'INTERBANK', bankCode: 'SIM-BANK-A', accountNumber: '12345678901', holderName: 'Kasun Fernando' }, amountMinor: 100_000 };
    const d = await create(a, body);
    expect(d.body).toMatchObject({ kind: 'INTERBANK_TRANSFER', feeMinor: 2500, totalMinor: 102_500 });
    expect((await authorize(a, d.body.id)).body.status).toBe('POSTED');
    expect(await bal(a)).toBe(1_000_000n - 102_500n);
    expect((await sysBal('SYS-FEE-INCOME-LKR')) - feeBefore).toBe(2500n);
    expect((await sysBal('SYS-INTERBANK-LKR')) - ibBefore).toBe(-100_000n); // cash/settlement ASSET goes down when money leaves the bank
    const bad = (over: object) => create(a, { ...body, destination: { ...body.destination, ...over } });
    expect((await bad({ accountNumber: '12345670000' })).status).toBe(400); // unverifiable (V1 test hook)
    expect((await bad({ bankCode: 'NOPE' })).status).toBe(400);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('insufficient funds is refused up-front, and FAILED (no ledger trace) if the balance drops before authorisation', async () => {
    const a = await payer(nm('poor'), 10_000n);
    const b = await payer(nm('poorb'), 0n);
    expect((await create(a, toZentrix(a, b, 10_001))).status).toBe(422);
    const d = await create(a, toZentrix(a, b, 8_000));
    expect(d.status).toBe(201);
    // balance drops (e.g. another payment) between review and authorisation
    await ledger.post({ reference: nm('DRAIN'), kind: 'T', currency: 'LKR', postings: [
      { ledgerAccountId: a.ledgerId, direction: 'DEBIT', amountMinor: 5_000n, currency: 'LKR' },
      { ledgerAccountId: b.ledgerId, direction: 'CREDIT', amountMinor: 5_000n, currency: 'LKR' } ] });
    const r = await authorize(a, d.body.id);
    expect(r.body).toMatchObject({ status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS', failureMessage: 'Insufficient funds' });
    expect(await journals(d.body.id)).toBe(0);
    expect(await bal(a)).toBe(5_000n);
    expect((await authorize(a, d.body.id)).body.status).toBe('FAILED'); // terminal, stays failed
  });

  it('Scenario I: the same Idempotency-Key sent 5 times concurrently creates exactly one payment', async () => {
    const a = await payer(nm('idem'), 1_000_000n);
    const b = await payer(nm('idemb'), 0n);
    const k = key();
    const body = toZentrix(a, b, 50_000);
    const rs = await Promise.all(Array.from({ length: 5 }, () => create(a, body, k)));
    expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.find((r) => r.status === 200)?.headers['idempotent-replayed']).toBe('true');
    expect(await ctx.prisma.paymentInstruction.count({ where: { initiatorId: a.id, idempotencyKey: k } })).toBe(1);

    expect((await create(a, { ...body, amountMinor: 50_001 }, k)).status).toBe(422); // same key, different body
    expect((await ctx.http.post('/api/v1/payments').set(bearer(a.token)).send(body)).status).toBe(400); // key required
    expect((await create(a, body, 'short')).status).toBe(400);

    const id = rs[0]!.body.id;
    const auths = await Promise.all(Array.from({ length: 5 }, () => authorize(a, id)));
    expect(auths.every((r) => r.status === 200 && r.body.status === 'POSTED')).toBe(true);
    expect(await journals(id)).toBe(1);
    expect(await bal(a)).toBe(950_000n); // debited exactly once
    expect((await authorize(a, id)).body.status).toBe('POSTED'); // later retry just returns the receipt
    expect(await bal(b)).toBe(50_000n);
  });

  it('Scenario J (backend): after a lost response the client can reconcile by key and never double-pays', async () => {
    const a = await payer(nm('lost'), 500_000n);
    const b = await payer(nm('lostb'), 0n);
    const k = key();
    expect((await ctx.http.get(`/api/v1/payments/by-key/${k}`).set(bearer(a.token))).status).toBe(404); // request never arrived => safe to retry
    const sent = await create(a, toZentrix(a, b, 20_000), k); // response "lost" on the way back
    const found = await ctx.http.get(`/api/v1/payments/by-key/${k}`).set(bearer(a.token));
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(sent.body.id);
    // the client then retries the create with the SAME key and gets the same draft
    expect((await create(a, toZentrix(a, b, 20_000), k)).body.id).toBe(sent.body.id);
    // authorisation response lost: poll the payment instead of assuming failure; a retry cannot double-post
    await authorize(a, sent.body.id);
    expect((await ctx.http.get(`/api/v1/payments/${sent.body.id}`).set(bearer(a.token))).body.status).toBe('POSTED');
    await authorize(a, sent.body.id);
    expect(await journals(sent.body.id)).toBe(1);
    expect(await bal(a)).toBe(480_000n);
    const other = await payer(nm('lostc'), 0n);
    expect((await ctx.http.get(`/api/v1/payments/by-key/${k}`).set(bearer(other.token))).status).toBe(404); // keys are per customer
  });

  it('Scenario H via the API: 6 concurrent payments of 300 against 1,000 -> exactly 3 post', async () => {
    const a = await payer(nm('race'), 100_000n);
    const b = await payer(nm('raceb'), 0n);
    const drafts = await Promise.all(Array.from({ length: 6 }, () => create(a, toZentrix(a, b, 30_000))));
    expect(drafts.every((d) => d.status === 201)).toBe(true);
    const results = await Promise.all(drafts.map((d) => authorize(a, d.body.id)));
    expect(results.filter((r) => r.body.status === 'POSTED')).toHaveLength(3);
    expect(results.filter((r) => r.body.status === 'FAILED' && r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(3);
    expect(await bal(a)).toBe(10_000n);
    expect(await bal(b)).toBe(90_000n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('daily limit is enforced early and again under concurrency', async () => {
    await ctx.prisma.systemConfiguration.upsert({ where: { key: 'limits.dailyTransferMinor' }, update: { value: 100_000 }, create: { key: 'limits.dailyTransferMinor', value: 100_000 } });
    try {
      const a = await payer(nm('daily'), 5_000_000n);
      const b = await payer(nm('dailyb'), 0n);
      const d1 = await create(a, toZentrix(a, b, 60_000));
      const d2 = await create(a, toZentrix(a, b, 60_000)); // both fit when drafted (nothing posted yet)
      expect(d1.status).toBe(201);
      expect(d2.status).toBe(201);
      const rs = await Promise.all([authorize(a, d1.body.id), authorize(a, d2.body.id)]);
      expect(rs.filter((r) => r.body.status === 'POSTED')).toHaveLength(1);
      expect(rs.filter((r) => r.body.status === 'FAILED' && r.body.failureCode === 'LIMIT_EXCEEDED')).toHaveLength(1);
      expect(await bal(b)).toBe(60_000n);
      const early = await create(a, toZentrix(a, b, 60_000));
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('daily_limit_exceeded');
      const own = await makeLedgerAccount(ctx, a.id, 0n);
      expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'OWN', accountId: own.id }, amountMinor: 200_000 })).status).toBe(201); // own-account moves are exempt
    } finally {
      await ctx.prisma.systemConfiguration.delete({ where: { key: 'limits.dailyTransferMinor' } });
    }
  });

  it('account restrictions and ownership: frozen source, foreign source/destination, same account', async () => {
    const a = await payer(nm('own'), 500_000n);
    const b = await payer(nm('ownb'), 500_000n);
    expect((await create(a, { sourceAccountId: b.accountId, destination: { type: 'ZENTRIX', accountNumber: a.number }, amountMinor: 1000 })).status).toBe(404); // not my source
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: a.id } })).toBeGreaterThan(0);
    expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'OWN', accountId: b.accountId }, amountMinor: 1000 })).status).toBe(404); // not my destination
    expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: a.number }, amountMinor: 1000 })).status).toBe(400); // same account
    expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: '99999999999' }, amountMinor: 1000 })).status).toBe(404);

    const d = await create(a, toZentrix(a, b, 1000));
    await ctx.prisma.account.update({ where: { id: a.accountId }, data: { status: 'FROZEN' } }); // frozen after review
    expect((await authorize(a, d.body.id)).body).toMatchObject({ status: 'FAILED', failureCode: 'ACCOUNT_RESTRICTED' });
    expect((await create(a, toZentrix(a, b, 1000))).status).toBe(409); // frozen accounts cannot even draft
    // a frozen account can still RECEIVE
    const c = await create(b, toZentrix(b, a, 2000));
    expect((await authorize(b, c.body.id)).body.status).toBe('POSTED');
  });

  it('beneficiaries: server-resolved names, validation, duplicates, favourites, isolation, pay via beneficiary', async () => {
    const a = await payer(nm('bene'), 500_000n);
    const b = await payer(nm('beneb'), 0n);
    const other = await payer(nm('benec'), 0n);
    const add = (p: P, body: object) => ctx.http.post('/api/v1/beneficiaries').set(bearer(p.token)).send(body);
    const z = await add(a, { bankCode: 'ZENTRIX', accountNumber: b.number, nickname: 'Bee', holderName: 'Fake Name' });
    expect(z.status).toBe(201);
    expect(z.body.holderName).toBe(await fullName(b)); // the client cannot choose the holder name
    expect(z.body.accountNumberMasked).toMatch(/^\*{7}\d{4}$/);
    expect((await add(a, { bankCode: 'ZENTRIX', accountNumber: b.number })).status).toBe(409);
    expect((await add(a, { bankCode: 'ZENTRIX', accountNumber: a.number })).status).toBe(400); // own account
    expect((await add(a, { bankCode: 'ZENTRIX', accountNumber: '88888888888' })).status).toBe(404);
    expect((await add(a, { bankCode: 'SIM-BANK-B', accountNumber: '55555555' })).status).toBe(400); // holder name required
    expect((await add(a, { bankCode: 'SIM-BANK-B', accountNumber: '55550000', holderName: 'X Y' })).status).toBe(400); // unverifiable
    const ext = await add(a, { bankCode: 'SIM-BANK-B', accountNumber: '55555555', holderName: 'Nimali Jay' });
    expect(ext.status).toBe(201);
    await ctx.http.put(`/api/v1/beneficiaries/${ext.body.id}`).set(bearer(a.token)).send({ favorite: true, nickname: 'Nim' });
    const list = (await ctx.http.get('/api/v1/beneficiaries').set(bearer(a.token))).body.items;
    expect(list[0].id).toBe(ext.body.id); // favourites first
    expect(list[0].nickname).toBe('Nim');

    // isolation
    expect((await ctx.http.get('/api/v1/beneficiaries').set(bearer(other.token))).body.items).toHaveLength(0);
    expect((await ctx.http.put(`/api/v1/beneficiaries/${z.body.id}`).set(bearer(other.token)).send({ favorite: true })).status).toBe(404);
    expect((await ctx.http.delete(`/api/v1/beneficiaries/${z.body.id}`).set(bearer(other.token))).status).toBe(404);
    expect((await create(other, { sourceAccountId: other.accountId, destination: { type: 'BENEFICIARY', beneficiaryId: z.body.id }, amountMinor: 100 })).status).toBe(404);

    const d = await create(a, { sourceAccountId: a.accountId, destination: { type: 'BENEFICIARY', beneficiaryId: z.body.id }, amountMinor: 30_000 });
    expect(d.body.kind).toBe('INTERNAL_TRANSFER');
    expect((await authorize(a, d.body.id)).body.status).toBe('POSTED');
    expect(await bal(b)).toBe(30_000n);

    expect((await ctx.http.delete(`/api/v1/beneficiaries/${z.body.id}`).set(bearer(a.token))).status).toBe(204);
    expect((await ctx.http.get('/api/v1/beneficiaries').set(bearer(a.token))).body.items).toHaveLength(1);
    expect((await add(a, { bankCode: 'ZENTRIX', accountNumber: b.number })).status).toBe(201); // revived after delete
  });

  it('QR payments: identity-only payload, ownership enforced, foreign formats refused', async () => {
    const a = await payer(nm('qra'), 500_000n);
    const b = await payer(nm('qrb'), 0n);
    const qr = (await ctx.http.get(`/api/v1/payments-qr/${b.accountId}`).set(bearer(b.token))).body;
    expect(qr.payload).toBe(`ZENTRIX1|${b.number}`);
    expect(qr.payload).not.toMatch(/amount|balance/i);
    expect((await ctx.http.get(`/api/v1/payments-qr/${b.accountId}`).set(bearer(a.token))).status).toBe(404);
    const d = await create(a, { sourceAccountId: a.accountId, destination: { type: 'QR', payload: qr.payload }, amountMinor: 12_345 });
    expect(d.body.kind).toBe('QR_PAYMENT');
    expect((await authorize(a, d.body.id)).body.status).toBe('POSTED');
    expect(await bal(b)).toBe(12_345n);
    for (const bad of ['000201010212...EMVCo', 'ZENTRIX1|123', `ZENTRIX2|${b.number}`, `ZENTRIX1|${b.number}|1000`])
      expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'QR', payload: bad }, amountMinor: 100 })).status).toBe(400);
  });

  it('bill payments post to biller settlement; unknown billers are refused', async () => {
    const a = await payer(nm('bill'), 500_000n);
    const before = await sysBal('SYS-BILLERS-LKR');
    const cat = (await ctx.http.get('/api/v1/billers').set(bearer(a.token))).body;
    expect(cat.items.length).toBeGreaterThanOrEqual(10);
    const d = await create(a, { sourceAccountId: a.accountId, destination: { type: 'BILL', billerCode: 'ELEC-01', billRef: '0123456789' }, amountMinor: 450_000 / 10 });
    expect(d.body).toMatchObject({ kind: 'BILL_PAYMENT', feeMinor: 0 });
    expect(d.body.recipient.name).toMatch(/Island Power/);
    expect((await authorize(a, d.body.id)).body.status).toBe('POSTED');
    expect((await sysBal('SYS-BILLERS-LKR')) - before).toBe(-45_000n); // settlement ASSET decreases
    expect((await create(a, { sourceAccountId: a.accountId, destination: { type: 'BILL', billerCode: 'NOPE', billRef: '1234' }, amountMinor: 100 })).status).toBe(404);
  });

  it('scheduled payment: authorised now, executed once on its date by the job, cancellable before', async () => {
    const a = await payer(nm('sched'), 500_000n);
    const b = await payer(nm('schedb'), 0n);
    const when = new Date(Date.now() + 3_600_000);
    expect((await create(a, toZentrix(a, b, 1000, { scheduledFor: new Date(Date.now() - 1000).toISOString() }))).status).toBe(400); // past
    const d = await create(a, toZentrix(a, b, 40_000, { scheduledFor: when.toISOString() }));
    expect(d.status).toBe(201);
    const r = await authorize(a, d.body.id);
    expect(r.body.status).toBe('AUTHORIZED'); // armed, NOT executed
    expect(await bal(a)).toBe(500_000n);
    expect((await ctx.http.get('/api/v1/payments?scheduled=true').set(bearer(a.token))).body.items.map((x: { id: string }) => x.id)).toContain(d.body.id);

    await payments.runDue(new Date()); // not due yet
    expect(await journals(d.body.id)).toBe(0);
    const later = new Date(when.getTime() + 1000);
    const [x, y] = await Promise.all([payments.runDue(later), payments.runDue(later)]); // two workers at once
    expect(x.executed + y.executed).toBe(1);
    expect(await journals(d.body.id)).toBe(1);
    expect(await bal(b)).toBe(40_000n);
    await payments.runDue(new Date(later.getTime() + 60_000));
    expect(await journals(d.body.id)).toBe(1); // restart-safe: never twice

    const c = await create(a, toZentrix(a, b, 1000, { scheduledFor: when.toISOString() }));
    await authorize(a, c.body.id);
    expect((await ctx.http.post(`/api/v1/payments/${c.body.id}/cancel`).set(bearer(a.token))).body.status).toBe('CANCELLED');
    await payments.runDue(later);
    expect(await journals(c.body.id)).toBe(0);
    expect((await ctx.http.post(`/api/v1/payments/${d.body.id}/cancel`).set(bearer(a.token))).status).toBe(409); // already posted
  });

  it('recurring payments: weekly runs once per due date, survive concurrent workers, can be cancelled', async () => {
    const a = await payer(nm('rec'), 1_000_000n);
    const b = await payer(nm('recb'), 0n);
    const start = new Date(Date.now() + 3_600_000);
    const body = { sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 10_000, frequency: 'WEEKLY', startDate: start.toISOString(), pin: PIN };
    expect((await ctx.http.post('/api/v1/scheduled-payments').set(bearer(a.token)).send({ ...body, pin: '000000' })).status).toBe(401);
    const sp = await ctx.http.post('/api/v1/scheduled-payments').set(bearer(a.token)).send(body);
    expect(sp.status).toBe(201);

    const due = new Date(start.getTime() + 1000);
    const [r1, r2] = await Promise.all([payments.runDue(due), payments.runDue(due)]);
    expect(r1.recurringCreated + r2.recurringCreated).toBe(1);
    expect(await bal(b)).toBe(10_000n);
    expect((await payments.runDue(due)).executed).toBe(0); // same due date: nothing more
    expect(await bal(b)).toBe(10_000n);

    const row = await ctx.prisma.scheduledPayment.findUniqueOrThrow({ where: { id: sp.body.id } });
    expect(row.nextRunAt.getTime()).toBe(start.getTime() + 7 * 86_400_000);
    await payments.runDue(new Date(start.getTime() + 8 * 86_400_000));
    expect(await bal(b)).toBe(20_000n);

    expect((await ctx.http.get('/api/v1/scheduled-payments').set(bearer(a.token))).body.items).toHaveLength(1);
    expect((await ctx.http.delete(`/api/v1/scheduled-payments/${sp.body.id}`).set(bearer(b.token))).status).toBe(404); // not b's
    expect((await ctx.http.delete(`/api/v1/scheduled-payments/${sp.body.id}`).set(bearer(a.token))).status).toBe(204);
    await payments.runDue(new Date(start.getTime() + 30 * 86_400_000));
    expect(await bal(b)).toBe(20_000n);
  });

  it('a recurring run that cannot be paid FAILS visibly and the schedule carries on', async () => {
    const a = await payer(nm('recfail'), 5_000n);
    const b = await payer(nm('recfailb'), 0n);
    const start = new Date(Date.now() + 3_600_000);
    const sp = await ctx.http.post('/api/v1/scheduled-payments').set(bearer(a.token)).send({ sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 9_000, frequency: 'MONTHLY', startDate: start.toISOString(), pin: PIN });
    const r = await payments.runDue(new Date(start.getTime() + 1000));
    expect(r.failed).toBe(1);
    const row = await ctx.prisma.scheduledPayment.findUniqueOrThrow({ where: { id: sp.body.id } });
    expect(row.lastFailure).toBe('INSUFFICIENT_FUNDS');
    expect(row.active).toBe(true);
    expect(row.nextRunAt.getTime()).toBeGreaterThan(start.getTime());
    expect(await bal(a)).toBe(5_000n);
  });

  it('addInterval handles month ends', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addInterval(new Date('2026-12-15T10:00:00Z'), 'MONTHLY').toISOString()).toBe('2027-01-15T10:00:00.000Z');
    expect(addInterval(new Date('2026-03-01T00:00:00Z'), 'WEEKLY').toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('stale drafts expire; a crash after authorisation is recovered exactly once by the job', async () => {
    const a = await payer(nm('exp'), 500_000n);
    const b = await payer(nm('expb'), 0n);
    const d = await create(a, toZentrix(a, b, 1000));
    await ctx.prisma.paymentInstruction.update({ where: { id: d.body.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const r = await authorize(a, d.body.id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('payment_expired');
    expect((await ctx.http.get(`/api/v1/payments/${d.body.id}`).set(bearer(a.token))).body.status).toBe('CANCELLED');

    const stuck = await create(a, toZentrix(a, b, 7_000));
    // simulate: PIN accepted + status AUTHORIZED, then the process died before posting
    await ctx.prisma.paymentInstruction.update({ where: { id: stuck.body.id }, data: { status: 'AUTHORIZED', authorizedAt: new Date(Date.now() - 5 * 60_000) } });
    await Promise.all([payments.runDue(), payments.runDue()]);
    expect(await journals(stuck.body.id)).toBe(1);
    expect(await bal(b)).toBe(7_000n);
  });

  it('payments of other customers are invisible and untouchable (Scenario G)', async () => {
    const a = await payer(nm('privA'), 500_000n);
    const b = await payer(nm('privB'), 0n);
    const evil = await payer(nm('evil'), 500_000n);
    const d = await create(a, toZentrix(a, b, 1000));
    expect((await ctx.http.get(`/api/v1/payments/${d.body.id}`).set(bearer(evil.token))).status).toBe(404);
    expect((await authorize(evil, d.body.id)).status).toBe(404);
    expect((await ctx.http.post(`/api/v1/payments/${d.body.id}/cancel`).set(bearer(evil.token))).status).toBe(404);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: evil.id } })).toBe(3);
    expect((await ctx.http.get('/api/v1/payments').set(bearer(evil.token))).body.items).toHaveLength(0);
  });

  it('notifications: unread count, mark read, isolation', async () => {
    const a = await payer(nm('nota'), 500_000n);
    const b = await payer(nm('notb'), 0n);
    const d = await create(a, toZentrix(a, b, 1000));
    await authorize(a, d.body.id);
    await relayOutboxBatch(ctx.prisma as never, 500);
    const list = (await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body;
    expect(list.unread).toBeGreaterThanOrEqual(1);
    const nid = list.items[0].id;
    expect((await ctx.http.post(`/api/v1/notifications/${nid}/read`).set(bearer(a.token))).status).toBe(204); // someone else's: no effect
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body.unread).toBe(list.unread);
    await ctx.http.post(`/api/v1/notifications/${nid}/read`).set(bearer(b.token));
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body.unread).toBe(list.unread - 1);
    await ctx.http.post('/api/v1/notifications/read-all').set(bearer(b.token));
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body.unread).toBe(0);
  });

  it('internal job endpoint requires the shared secret; staff monitoring needs transactions.read', async () => {
    expect((await ctx.http.post('/api/v1/internal/jobs/run-due')).status).toBe(401);
    expect((await ctx.http.post('/api/v1/internal/jobs/run-due').set('x-internal-token', 'wrong'.padEnd(40, 'x'))).status).toBe(401);
    const ok = await ctx.http.post('/api/v1/internal/jobs/run-due').set('x-internal-token', JOB_TOKEN);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['cardsReady', 'depositsFailed', 'depositsMatured', 'depositsRenewed', 'errors', 'executed', 'expired', 'failed', 'loanReminders', 'loansOverdue', 'recurringCreated']);
    expect(ok.body.errors).toEqual([]);

    const comp = await makeStaff(ctx, nm('comp'), 'COMPLIANCE_OFFICER');
    const csr = await makeStaff(ctx, nm('csrx'), 'CUSTOMER_SERVICE');
    const list = await ctx.http.get('/api/v1/admin/payments?status=POSTED').set(bearer(comp.token));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0]).toHaveProperty('customerName');
    expect((await ctx.http.get('/api/v1/admin/payments').set(bearer(csr.token))).status).toBe(403);
  });

  it('after everything, the ledger reconciles', async () => {
    const r = await ledger.reconcile();
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
