import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { buyForeign, sellForeign } from '../src/modules/fx/fx.service';
import { bearer, boot, makeLedgerAccount, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

describe('FX arithmetic', () => {
  it('never rounds in the customer\'s favour and applies the spread on the right side', () => {
    const mid = 320_000_000n; // LKR 320.00 per USD
    const buy = buyForeign(32_000n, mid, 150); // LKR 320.00 -> USD at 320 * 1.015 = 324.80
    expect(buy.rateMicro).toBe(324_800_000n);
    expect(buy.toMinor).toBe(98n); // 32000 / 324.8 = 98.52 -> 98 cents, rounded down
    const sell = sellForeign(10_000n, mid, 150); // USD 100.00 -> LKR at 320 * 0.985 = 315.20
    expect(sell.rateMicro).toBe(315_200_000n);
    expect(sell.toMinor).toBe(3_152_000n);
    expect(sell.rateMicro < mid && buy.rateMicro > mid).toBe(true); // the bank always wins the spread
    // A round trip can only lose money.
    const there = buyForeign(1_000_000n, mid, 150);
    const back = sellForeign(there.toMinor, mid, 150);
    expect(back.toMinor < 1_000_000n).toBe(true);
    expect(buyForeign(0n, mid, 150).toMinor).toBe(0n);
  });
});

describe.skipIf(!TEST_DB)('foreign-currency exchange (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  const id = randomBytes(3).toString('hex');
  let n = 0;
  beforeAll(async () => {
    ctx = await boot();
    ledger = ctx.app.get(LedgerService);
    for (const [cur, micro] of [['USD', 320_000_000n], ['EUR', 350_000_000n], ['GBP', 410_000_000n]] as const) await ctx.prisma.fxRate.upsert({ where: { currency: cur }, update: { midRateMicro: micro }, create: { currency: cur, midRateMicro: micro } });
    await ctx.prisma.systemConfiguration.deleteMany({ where: { key: 'fx.spreadBps' } });
    for (const cur of ['USD', 'EUR']) await ctx.prisma.accountProduct.upsert({ where: { code: `FX_${cur}` }, update: {}, create: { code: `FX_${cur}`, name: `${cur} Account`, kind: 'FOREIGN_CURRENCY', currency: cur, minOpeningMinor: 0n } });
  });
  afterAll(async () => { await ctx.prisma.systemConfiguration.deleteMany({ where: { key: 'fx.spreadBps' } }); await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  async function fxAccount(customerId: string, cur: string) {
    const product = await ctx.prisma.accountProduct.findUniqueOrThrow({ where: { code: `FX_${cur}` } });
    const num = `8${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;
    return ctx.prisma.account.create({ data: { customerId, productId: product.id, accountNumber: num, currency: cur, ledgerAccount: { create: { code: `ACC-${num}`, name: num, type: 'LIABILITY', currency: cur, balanceMinor: 0n } } }, include: { ledgerAccount: true } });
  }
  const A = (p: Payer, m: 'get' | 'post' | 'put', path: string, body?: object) => ctx.http[m](`/api/v1${path}`).set(bearer(p.token)).send(body);
  const bal = async (acc: { ledgerAccount?: { id: string } | null }) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: acc.ledgerAccount!.id } })).balanceMinor;

  it('a foreign-currency account is applied for like any other, opens with no deposit, and is funded by exchange', async () => {
    const a = await makePayer(ctx, `fxo${n++}${id}`, 2_000_000n);
    const officer = await makeStaff(ctx, `fxof${n++}${id}`, 'ACCOUNT_OFFICER');
    const prods = (await A(a, 'get', '/account-products')).body.items;
    expect(prods.find((p: { code: string }) => p.code === 'FX_USD')).toMatchObject({ currency: 'USD', minOpeningMinor: 0 });
    const app = await A(a, 'post', '/account-applications', { productCode: 'FX_USD', nickname: 'Travel dollars' });
    expect(app.status).toBe(201);
    const dec = await ctx.http.post(`/api/v1/admin/account-applications/${app.body.id}/decision`).set(bearer(officer.token)).send({ decision: 'APPROVE', openingDepositMinor: 0 });
    expect(dec.status).toBe(201);
    const list = (await A(a, 'get', '/accounts')).body;
    const usd = list.items.find((x: { currency: string }) => x.currency === 'USD');
    expect(usd).toMatchObject({ balanceMinor: 0, nickname: 'Travel dollars' });
    expect(list.totalBalanceMinor).toBe(2_000_000); // the total counts rupee accounts only: dollars are never added to rupees

    const q = await A(a, 'get', `/fx/quote?fromAccountId=${a.accountId}&toAccountId=${usd.id}&amountMinor=649600`);
    expect(q.body.toAmountMinor).toBe(2000);
    expect((await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: PIN })).status).toBe(200);
    const after = (await A(a, 'get', '/accounts')).body;
    expect(after.items.find((x: { currency: string }) => x.currency === 'USD').balanceMinor).toBe(2000);
    expect(after.totalBalanceMinor).toBe(2_000_000 - 649_600);
    const tx = (await A(a, 'get', `/accounts/${usd.id}/transactions`)).body.items;
    expect(tx[0]).toMatchObject({ amountMinor: 2000 });
  });

  it('lists rates with the spread, and a customer can see them', async () => {
    const a = await makePayer(ctx, `fxr${n++}${id}`, 0n);
    const r = (await A(a, 'get', '/fx/rates')).body;
    const usd = r.items.find((x: { currency: string }) => x.currency === 'USD');
    expect(usd).toMatchObject({ midRate: 320, youPayPerUnit: 324.8, youGetPerUnit: 315.2 });
    expect(r.spreadBps).toBe(150);
    expect((await ctx.http.get('/api/v1/fx/rates')).status).toBe(401);
  });

  it('quote -> exchange: two balanced single-currency journals post atomically, nothing is created or lost', async () => {
    const a = await makePayer(ctx, `fxa${n++}${id}`, 5_000_000n); // LKR 50,000.00
    const usd = await fxAccount(a.id, 'USD');
    const q = await A(a, 'get', `/fx/quote?fromAccountId=${a.accountId}&toAccountId=${usd.id}&amountMinor=3248000`); // LKR 32,480.00
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ fromCurrency: 'LKR', toCurrency: 'USD', toAmountMinor: 10_000, rate: 324.8 }); // exactly USD 100.00
    const before = { lkr: await bal(a.acc), usd: await bal(usd) };

    expect((await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: '000000' })).status).toBe(401);
    const done = await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: PIN });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ replayed: false, fromAmountMinor: 3_248_000, toAmountMinor: 10_000 });
    expect(before.lkr - (await bal(a.acc))).toBe(3_248_000n);
    expect((await bal(usd)) - before.usd).toBe(10_000n);

    // Repeating the same confirmation (lost response) does not exchange twice.
    const again = await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: PIN });
    expect(again.body.replayed).toBe(true);
    expect((await bal(usd)) - before.usd).toBe(10_000n);
    const journals = await ctx.prisma.ledgerJournal.findMany({ where: { reference: { startsWith: `FX-${done.body.reference.slice(3)}` } }, include: { postings: true } });
    expect(journals).toHaveLength(2);
    for (const j of journals) {
      const d = j.postings.filter((p) => p.direction === 'DEBIT').reduce((s, p) => s + p.amountMinor, 0n);
      const c = j.postings.filter((p) => p.direction === 'CREDIT').reduce((s, p) => s + p.amountMinor, 0n);
      expect(d).toBe(c);
      expect(j.postings.every((p) => p.currency === j.currency)).toBe(true);
    }
    expect(await ctx.prisma.auditLog.count({ where: { actorId: a.id, action: 'fx.exchanged' } })).toBe(1);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await A(a, 'get', '/notifications')).body.items.some((x: { title: string }) => x.title === 'Currency exchanged')).toBe(true);

    // And back: selling USD 40.00 returns LKR at the worse (sell) rate.
    const sellQ = await A(a, 'get', `/fx/quote?fromAccountId=${usd.id}&toAccountId=${a.accountId}&amountMinor=4000`);
    expect(sellQ.body).toMatchObject({ fromCurrency: 'USD', toCurrency: 'LKR', toAmountMinor: 1_260_800, rate: 315.2 });
    expect((await A(a, 'post', '/fx/exchange', { token: sellQ.body.token, pin: PIN })).status).toBe(200);
    expect(await bal(usd)).toBe(6_000n);
  });

  it('exchange is not income or spending, and statements for the foreign account use its own currency', async () => {
    const a = await makePayer(ctx, `fxs${n++}${id}`, 5_000_000n);
    const usd = await fxAccount(a.id, 'USD');
    const income0 = (await A(a, 'get', '/analytics/summary')).body;
    const q = await A(a, 'get', `/fx/quote?fromAccountId=${a.accountId}&toAccountId=${usd.id}&amountMinor=1000000`);
    await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: PIN });
    const income1 = (await A(a, 'get', '/analytics/summary')).body;
    expect(income1.moneyInMinor).toBe(income0.moneyInMinor);
    expect(income1.spentMinor).toBe(income0.spentMinor);

    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const csv = await ctx.http.get(`/api/v1/accounts/${usd.id}/statement?format=csv&from=${today}&to=${today}`).set(bearer(a.token));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Currency exchange LKR to USD');
    const pdf = await ctx.http.get(`/api/v1/accounts/${usd.id}/statement?format=pdf`).set(bearer(a.token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).toString('latin1')).not.toContain('LKR');
  });

  it('refuses what must be refused: same currency, foreign-to-foreign, other people\'s accounts, tampered, expired or someone else\'s quote, insufficient funds', async () => {
    const a = await makePayer(ctx, `fxb${n++}${id}`, 1_000_000n);
    const b = await makePayer(ctx, `fxc${n++}${id}`, 1_000_000n);
    const usd = await fxAccount(a.id, 'USD');
    const eur = await fxAccount(a.id, 'EUR');
    const bUsd = await fxAccount(b.id, 'USD');
    const lkr2 = await makeLedgerAccount(ctx, a.id, 0n);
    const quote = (from: string, to: string, amt: number, who = a) => A(who, 'get', `/fx/quote?fromAccountId=${from}&toAccountId=${to}&amountMinor=${amt}`);

    expect((await quote(a.accountId, lkr2.id, 100_000)).status).toBe(400); // same currency
    expect((await quote(usd.id, eur.id, 100)).status).toBe(422); // must go through rupees
    expect((await quote(a.accountId, bUsd.id, 100_000)).status).toBe(404); // not yours
    expect((await quote(bUsd.id, a.accountId, 100)).status).toBe(404);
    expect((await quote(a.accountId, usd.id, 0)).status).toBe(400);
    expect((await quote(a.accountId, usd.id, 10)).status).toBe(422); // too small to buy a cent

    const good = await quote(a.accountId, usd.id, 500_000);
    const [body, sig] = good.body.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), o: '99999999' })).toString('base64url');
    expect((await A(a, 'post', '/fx/exchange', { token: `${forged}.${sig}`, pin: PIN })).status).toBe(422); // tampered amount
    expect((await A(a, 'post', '/fx/exchange', { token: good.body.token.slice(0, -3) + 'abc', pin: PIN })).status).toBe(422);
    expect((await A(b, 'post', '/fx/exchange', { token: good.body.token, pin: PIN })).status).toBe(422); // another customer's quote

    const expired = JSON.parse(Buffer.from(body, 'base64url').toString());
    expired.exp = Date.now() - 1000;
    const exp64 = Buffer.from(JSON.stringify(expired)).toString('base64url');
    expect((await A(a, 'post', '/fx/exchange', { token: `${exp64}.${sig}`, pin: PIN })).status).toBe(422); // signature no longer matches the edit

    const tooMuch = await quote(a.accountId, usd.id, 2_000_000); // more than the LKR 10,000.00 balance
    const r = await A(a, 'post', '/fx/exchange', { token: tooMuch.body.token, pin: PIN });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('insufficient_funds');
    expect(await bal(usd)).toBe(0n); // nothing leaked from a failed attempt
    expect(await ctx.prisma.ledgerJournal.count({ where: { reference: { startsWith: 'FX-' }, postings: { some: { ledgerAccountId: usd.ledgerAccount!.id } } } })).toBe(0);
  });

  it('a frozen account cannot take part, and the ledger still reconciles afterwards', async () => {
    const a = await makePayer(ctx, `fxd${n++}${id}`, 1_000_000n);
    const usd = await fxAccount(a.id, 'USD');
    const q = await A(a, 'get', `/fx/quote?fromAccountId=${a.accountId}&toAccountId=${usd.id}&amountMinor=100000`);
    await ctx.prisma.account.update({ where: { id: usd.id }, data: { status: 'FROZEN' } });
    expect((await A(a, 'post', '/fx/exchange', { token: q.body.token, pin: PIN })).status).toBe(422);
    expect((await A(a, 'get', `/fx/quote?fromAccountId=${a.accountId}&toAccountId=${usd.id}&amountMinor=100000`)).status).toBe(422);
    const recon = await ledger['prisma'].$queryRawUnsafe<{ bad: bigint }[]>(`SELECT count(*)::bigint AS bad FROM (SELECT "journalId" FROM "LedgerPosting" GROUP BY "journalId", currency HAVING sum(CASE WHEN direction='DEBIT' THEN "amountMinor" ELSE -"amountMinor" END) <> 0) t`);
    expect(recon[0]!.bad).toBe(0n);
  });

  it('staff set rates within a sanity band, audited; customers cannot', async () => {
    const admin = await makeStaff(ctx, `fxadm${n++}${id}`, 'BANK_ADMIN');
    const cs = await makeStaff(ctx, `fxcs${n++}${id}`, 'CUSTOMER_SERVICE');
    const c = await makePayer(ctx, `fxe${n++}${id}`, 0n);
    const put = (t: string, cur: string, body: object) => ctx.http.put(`/api/v1/admin/fx/rates/${cur}`).set(bearer(t)).send(body);
    expect((await put(c.token, 'USD', { midRate: 321 })).status).toBe(403);
    expect((await put(cs.token, 'USD', { midRate: 321 })).status).toBe(403);
    expect((await put(admin.token, 'USD', { midRate: 500 })).status).toBe(422); // +56%: fat finger
    expect((await put(admin.token, 'JPY', { midRate: 2 })).status).toBe(422);
    expect((await put(admin.token, 'USD', { midRate: -1 })).status).toBe(400);
    const ok = await put(admin.token, 'USD', { midRate: 330 });
    expect(ok.status).toBe(200);
    expect(ok.body.items.find((x: { currency: string }) => x.currency === 'USD').midRate).toBe(330);
    expect((await A(c, 'get', '/fx/rates')).body.items.find((x: { currency: string }) => x.currency === 'USD').midRate).toBe(330);
    expect(await ctx.prisma.auditLog.count({ where: { actorId: admin.id, action: 'fx.rate_changed' } })).toBe(1);
    await ctx.prisma.fxRate.update({ where: { currency: 'USD' }, data: { midRateMicro: 320_000_000n } });
  });
});
