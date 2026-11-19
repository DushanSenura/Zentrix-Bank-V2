import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { MaintenanceService } from '../src/modules/admin/settings.service';
import { encrypt } from '../src/security/crypto';
import { totpNow } from '../src/security/totp';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makeCustomer, makePayer, makeStaff, PIN, PW, TEST_DB, u, type Ctx, type Payer } from './helpers';

const key = () => randomBytes(16).toString('hex');

describe.skipIf(!TEST_DB)('administration (real database)', () => {
  let ctx: Ctx;
  let ledger: LedgerService;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;
  beforeAll(async () => { ctx = await boot(); ledger = ctx.app.get(LedgerService); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const get = (token: string, path: string) => ctx.http.get(`/api/v1${path}`).set(bearer(token));
  const post = (token: string, path: string, body: object = {}) => ctx.http.post(`/api/v1${path}`).set(bearer(token)).send(body);
  const put = (token: string, path: string, body: object = {}) => ctx.http.put(`/api/v1${path}`).set(bearer(token)).send(body);
  const bal = async (id: string) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } })).balanceMinor;

  async function transfer(from: Payer, to: Payer, amountMinor: number) {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(from.token)).set('Idempotency-Key', key()).send({ sourceAccountId: from.accountId, destination: { type: 'ZENTRIX', accountNumber: to.number }, amountMinor });
    const r = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(from.token)).send({ pin: PIN });
    expect(r.body.status).toBe('POSTED');
    return r.body.id as string;
  }

  it('dashboard: real aggregates, and each staff member sees only the sections their permissions allow', async () => {
    const admin = await makeStaff(ctx, nm('dadm'), 'BANK_ADMIN');
    const auditor = await makeStaff(ctx, nm('daud'), 'AUDITOR');
    const csr = await makeStaff(ctx, nm('dcsr'), 'CUSTOMER_SERVICE');
    const a = await makePayer(ctx, nm('dpay'), 500_000n);
    const b = await makePayer(ctx, nm('dpayb'), 0n);
    await transfer(a, b, 10_000);

    const d = (await get(admin.token, '/admin/dashboard')).body;
    expect(d.customers.total).toBe(await ctx.prisma.user.count({ where: { type: 'CUSTOMER' } }));
    expect(d.customers.active).toBe(await ctx.prisma.user.count({ where: { type: 'CUSTOMER', status: 'ACTIVE' } }));
    const liab = await ctx.prisma.$queryRaw<{ v: bigint }[]>`SELECT COALESCE(SUM("balanceMinor"),0)::bigint AS v FROM "LedgerAccount" WHERE type = 'LIABILITY' AND currency = 'LKR'`;
    expect(d.finance.depositLiabilitiesMinor).toBe(Number(liab[0]!.v)); // straight from the ledger, not a cache
    expect(d.finance.today.transfers).toBeGreaterThanOrEqual(1);
    expect(d.finance.today.volumeMinor).toBeGreaterThanOrEqual(10_000);
    const days = d.finance.series.map((s: { day: string }) => s.day);
    expect([...days].sort()).toEqual(days);
    expect(d.pending.cards).toBe(await ctx.prisma.card.count({ where: { status: 'PENDING_APPROVAL' } }));
    expect(d.pending.kyc).toBe(await ctx.prisma.customerProfile.count({ where: { kycStatus: 'SUBMITTED' } }));
    expect(d.recentAudit.length).toBeGreaterThan(0);

    const aud = (await get(auditor.token, '/admin/dashboard')).body;
    expect(aud.finance).toBeTruthy();
    expect(aud.recentAudit).toBeTruthy();
    expect(aud.customers).toBeUndefined(); // auditors have no customers.read
    expect(aud.pending).toEqual({});

    const c = (await get(csr.token, '/admin/dashboard')).body;
    expect(c.customers).toBeTruthy();
    expect(c.finance).toBeUndefined();
    expect(c.recentAudit).toBeUndefined();
    expect((await get(a.token, '/admin/dashboard')).status).toBe(403); // customers cannot reach staff routes
    expect((await ctx.http.get('/api/v1/admin/dashboard')).status).toBe(401);
  });

  it('customers: search, pagination, 360 view with masked identity, suspend/restore take effect immediately', async () => {
    const admin = await makeStaff(ctx, nm('cadm'), 'BANK_ADMIN');
    const csr = await makeStaff(ctx, nm('ccsr'), 'CUSTOMER_SERVICE');
    const tag = nm('zq');
    const cs: Payer[] = [];
    for (let i = 0; i < 3; i++) cs.push(await makePayer(ctx, `${tag}${i}`, 100_000n));
    const target = cs[0]!;
    const profile = await ctx.prisma.customerProfile.update({ where: { userId: target.id }, data: { nationalIdEnc: encrypt('199012345678', Buffer.from(process.env.DATA_ENCRYPTION_KEY!, 'base64')), dateOfBirth: new Date('1990-05-05') } });

    const s1 = (await get(admin.token, `/admin/customers?q=${tag}&limit=2`)).body;
    expect(s1.items).toHaveLength(2);
    expect(s1.nextCursor).toBeTruthy();
    const s2 = (await get(admin.token, `/admin/customers?q=${tag}&limit=2&cursor=${s1.nextCursor}`)).body;
    expect(s2.items).toHaveLength(1);
    expect(s2.nextCursor).toBeNull();
    expect(new Set([...s1.items, ...s2.items].map((i: { userId: string }) => i.userId)).size).toBe(3); // stable, no overlap
    expect((await get(admin.token, `/admin/customers?q=${profile.customerNumber}`)).body.items[0].userId).toBe(target.id);
    expect((await get(admin.token, '/admin/customers?status=SUSPENDED&limit=5')).body.items.every((i: { status: string }) => i.status === 'SUSPENDED')).toBe(true);
    expect((await get(admin.token, '/admin/customers?cursor=garbage')).status).toBe(400);

    const d = await get(csr.token, `/admin/customers/${target.id}`); // customer service can read
    expect(d.status).toBe(200);
    expect(d.body.kyc.nationalIdMasked).toBe('********5678');
    expect(JSON.stringify(d.body)).not.toContain('199012345678'); // never the full ID
    expect(JSON.stringify(d.body)).not.toMatch(/passwordHash|pinHash|mfaSecret/);
    expect(d.body.accounts[0]).toMatchObject({ balanceMinor: 100_000, status: 'ACTIVE' });
    expect(d.body.security.activeSessions).toBeGreaterThanOrEqual(1);
    expect((await get(admin.token, `/admin/customers/${admin.id}`)).status).toBe(404); // a staff id is not a customer
    expect((await get(admin.token, '/admin/customers/not-a-uuid')).status).toBe(400);

    expect((await post(csr.token, `/admin/customers/${target.id}/suspend`, { reason: 'Fraud review' })).status).toBe(403);
    expect((await post(admin.token, `/admin/customers/${target.id}/suspend`, { reason: 'x' })).status).toBe(400);
    expect((await get(target.token, '/accounts')).status).toBe(200);
    const sus = await post(admin.token, `/admin/customers/${target.id}/suspend`, { reason: 'Fraud review' });
    expect(sus.body.status).toBe('SUSPENDED');
    expect((await get(target.token, '/accounts')).status).toBe(401); // existing session is dead right now
    expect((await ctx.http.post('/api/v1/auth/login').send({ identifier: u(`${tag}0`), password: PW })).status).toBe(401);
    expect((await post(admin.token, `/admin/customers/${target.id}/suspend`, { reason: 'again again' })).status).toBe(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'customer.suspended', subjectId: target.id, actorId: admin.id } })).toBe(1);

    expect((await post(admin.token, `/admin/customers/${target.id}/restore`, { reason: 'Cleared' })).body.status).toBe('ACTIVE');
    expect((await ctx.http.post('/api/v1/auth/login').send({ identifier: u(`${tag}0`), password: PW })).status).toBe(200);
    expect((await post(admin.token, `/admin/customers/${target.id}/restore`, { reason: 'Cleared' })).status).toBe(409); // not suspended

    // restoring never skips verification
    const other = cs[1]!;
    await ctx.prisma.customerProfile.update({ where: { userId: other.id }, data: { kycStatus: 'SUBMITTED' } });
    await post(admin.token, `/admin/customers/${other.id}/suspend`, { reason: 'Review' });
    expect((await post(admin.token, `/admin/customers/${other.id}/restore`, { reason: 'Review done' })).body.status).toBe('PENDING_VERIFICATION');
  });

  it('staff: invitation, single-use setup with MFA enrolment, and every privilege-escalation guard', async () => {
    const admin = await makeStaff(ctx, nm('sadm'), 'BANK_ADMIN');
    const sup = await makeStaff(ctx, nm('ssup'), 'SUPER_ADMIN');
    const un = nm('newofficer');
    const inv = await post(admin.token, '/admin/staff', { fullName: 'New Officer', username: un, email: `${un}@t.test`, roleKeys: ['CARD_OFFICER'] });
    expect(inv.status).toBe(201);
    expect(inv.body.setupToken).toBeTruthy(); // dev only
    expect((await post(admin.token, '/admin/staff', { fullName: 'Dup', username: un, email: `${un}@t.test`, roleKeys: ['CARD_OFFICER'] })).status).toBe(409);
    expect((await ctx.http.post('/api/v1/auth/login').send({ identifier: un, password: PW })).status).toBe(401); // cannot sign in before setup

    const setup = (token: string, password: string) => ctx.http.post('/api/v1/auth/staff-setup').send({ token, password });
    expect((await setup('x'.repeat(30), PW)).status).toBe(401);
    expect((await setup(inv.body.setupToken, 'weak')).status).toBe(400);
    const ok = await setup(inv.body.setupToken, PW);
    expect(ok.status).toBe(200);
    expect(ok.body.secret).toBeTruthy();
    expect(ok.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await setup(inv.body.setupToken, PW)).status).toBe(401); // single use
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { username: un } });
    expect(row.mfaSecretEnc).not.toContain(ok.body.secret); // stored encrypted

    const login = await ctx.http.post('/api/v1/auth/login').send({ identifier: un, password: PW, mfaCode: totpNow(ok.body.secret) });
    expect(login.status).toBe(200);
    const officer = { id: row.id, token: login.body.accessToken as string };
    expect((await get(officer.token, '/me')).body.permissions).toContain('cards.review');

    // escalation guards
    expect((await post(officer.token, '/admin/staff', { fullName: 'X Y', username: nm('x'), email: `${nm('x')}@t.test`, roleKeys: ['CARD_OFFICER'] })).status).toBe(403); // no staff.manage
    const esc = await post(admin.token, '/admin/staff', { fullName: 'Sneaky', username: nm('sn'), email: `${nm('sn')}@t.test`, roleKeys: ['SUPER_ADMIN'] });
    expect(esc.status).toBe(403);
    expect(esc.body.code).toBe('privilege_escalation');
    expect((await put(admin.token, `/admin/staff/${admin.id}/roles`, { roleKeys: ['SUPER_ADMIN'] })).body.code).toBe('self_modification');
    expect((await put(admin.token, `/admin/staff/${sup.id}/roles`, { roleKeys: ['CARD_OFFICER'] })).body.code).toBe('target_more_privileged'); // cannot demote a more powerful user
    expect((await post(admin.token, `/admin/staff/${sup.id}/deactivate`, { reason: 'Because' })).body.code).toBe('target_more_privileged');
    expect((await put(admin.token, `/admin/staff/${officer.id}/roles`, { roleKeys: ['NOPE'] })).status).toBe(400);
    expect((await post(admin.token, `/admin/staff/${admin.id}/deactivate`, { reason: 'Myself' })).body.code).toBe('self_modification');

    // allowed: grant a role the admin itself covers; sessions are revoked so the new access applies on next sign-in
    const grant = await put(admin.token, `/admin/staff/${officer.id}/roles`, { roleKeys: ['CARD_OFFICER', 'ACCOUNT_OFFICER'] });
    expect(grant.status).toBe(200);
    expect((await get(officer.token, '/me')).status).toBe(401);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'staff.roles_changed', subjectId: officer.id, actorId: admin.id } })).toBe(1);

    // deactivate / activate / revoke
    const relog = async () => (await ctx.http.post('/api/v1/auth/login').send({ identifier: un, password: PW, mfaCode: totpNow(ok.body.secret) }));
    const t1 = (await relog()).body.accessToken as string;
    expect((await post(admin.token, `/admin/staff/${officer.id}/deactivate`, { reason: 'Left the bank' })).body.active).toBe(false);
    expect((await get(t1, '/me')).status).toBe(401);
    expect((await relog()).status).toBe(401);
    expect((await post(admin.token, `/admin/staff/${officer.id}/activate`, { reason: 'Returned' })).body.active).toBe(true);
    const t2 = (await relog());
    expect(t2.status).toBe(200);
    expect((await post(admin.token, `/admin/staff/${officer.id}/revoke-sessions`)).body.revoked).toBeGreaterThanOrEqual(1);
    expect((await get(t2.body.accessToken, '/me')).status).toBe(401);

    const list = (await get(admin.token, '/admin/staff')).body.items.find((s: { userId: string }) => s.userId === officer.id);
    expect(list).toMatchObject({ mfaEnrolled: true, active: true });
    expect(list.roles.sort()).toEqual(['ACCOUNT_OFFICER', 'CARD_OFFICER']);
    expect((await get(admin.token, `/admin/staff/${officer.id}/login-history`)).body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|mfaSecret/);
  });

  it('roles: only roles.manage can edit; nobody can grant what they lack; the Super Administrator role is immutable', async () => {
    const admin = await makeStaff(ctx, nm('radm'), 'BANK_ADMIN'); // staff.manage but NOT roles.manage
    const sup = await makeStaff(ctx, nm('rsup'), 'SUPER_ADMIN');
    const cardOfficer = await makeStaff(ctx, nm('rco'), 'CARD_OFFICER');
    const view = (await get(admin.token, '/admin/roles')).body;
    expect(view.items.find((r: { key: string }) => r.key === 'SUPER_ADMIN').permissions.length).toBe(view.permissions.length);
    expect((await put(admin.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['cards.review', 'reports.read'] })).status).toBe(403);
    expect((await put(sup.token, '/admin/roles/SUPER_ADMIN/permissions', { permissionKeys: [] })).body.code).toBe('immutable_role');
    expect((await put(sup.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['made.up'] })).status).toBe(400);
    expect((await put(sup.token, '/admin/roles/NOPE/permissions', { permissionKeys: [] })).status).toBe(404);

    expect((await get(cardOfficer.token, '/admin/reports/audit-activity')).status).toBe(403);
    try {
      expect((await put(sup.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['customers.read', 'cards.review', 'reports.read'] })).status).toBe(200);
      expect((await get(cardOfficer.token, '/admin/reports/audit-activity')).status).toBe(200); // takes effect on the next request
      expect(await ctx.prisma.auditLog.count({ where: { action: 'role.permissions_changed', subjectId: 'CARD_OFFICER', actorId: sup.id } })).toBeGreaterThanOrEqual(1);

      // an editor with roles.manage but limited permissions cannot hand out what they do not hold
      const role = await ctx.prisma.role.create({ data: { key: nm('EDITOR').toUpperCase(), name: 'Test editor' } });
      const perms = await ctx.prisma.permission.findMany({ where: { key: { in: ['roles.manage', 'staff.manage', 'reports.read'] } } });
      await ctx.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      const editor = await makeStaff(ctx, nm('edt'), role.key);
      const esc = await put(editor.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['customers.read', 'cards.review', 'reports.read', 'customers.suspend'] });
      expect(esc.status).toBe(403);
      expect(esc.body.code).toBe('privilege_escalation');
      expect((await put(editor.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['customers.read', 'cards.review', 'reports.read'] })).status).toBe(200); // no new grants: fine
    } finally {
      await put(sup.token, '/admin/roles/CARD_OFFICER/permissions', { permissionKeys: ['customers.read', 'cards.review'] });
    }
    expect((await get(cardOfficer.token, '/admin/reports/audit-activity')).status).toBe(403);
  });

  it('audit log: filters, pagination, permissions, and a formula-safe CSV export that is itself audited', async () => {
    const admin = await makeStaff(ctx, nm('aadm'), 'BANK_ADMIN');
    const auditor = await makeStaff(ctx, nm('aaud'), 'AUDITOR');
    const csr = await makeStaff(ctx, nm('acsr'), 'CUSTOMER_SERVICE');
    const evil = `=HYPERLINK("http://evil.test","x")${runId}`;
    await ctx.prisma.auditLog.create({ data: { actorType: 'SYSTEM', action: evil, subjectType: 'Test', subjectId: runId, metadata: { secret: 'must-not-be-exported' } } });
    for (let i = 0; i < 3; i++) await post(admin.token, `/admin/customers/${admin.id}/suspend`, { reason: 'noise noise' }); // 404s, no rows; ensure other rows exist
    const all = (await get(auditor.token, '/admin/audit?limit=2')).body;
    expect(all.items).toHaveLength(2);
    const next = (await get(auditor.token, `/admin/audit?limit=2&cursor=${all.nextCursor}`)).body;
    expect(next.items.map((i: { id: string }) => i.id)).not.toContain(all.items[0].id);
    const filtered = (await get(auditor.token, `/admin/audit?subjectType=Test&subjectId=${runId}`)).body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].actorType).toBe('SYSTEM');
    expect((await get(auditor.token, '/admin/audit?from=not-a-date')).status).toBe(400);
    expect((await get(csr.token, '/admin/audit')).status).toBe(403);
    expect((await get(csr.token, '/admin/audit-export')).status).toBe(403);
    expect((await get(auditor.token, '/admin/security-events')).status).toBe(200);

    const ex = await get(auditor.token, `/admin/audit-export?subjectId=${runId}`);
    expect(ex.status).toBe(200);
    expect(ex.headers['content-type']).toMatch(/text\/csv/);
    expect(ex.headers['content-disposition']).toMatch(/attachment/);
    expect(ex.text.split('\r\n')[0]).toBe('at,actorType,actorName,actorId,action,subjectType,subjectId,reasonCode,ip');
    expect(ex.text).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")${runId}"`); // neutralised and correctly quoted
    expect(ex.text).not.toContain('must-not-be-exported'); // metadata is not exported
    expect(await ctx.prisma.auditLog.count({ where: { action: 'audit.exported', actorId: auditor.id } })).toBe(1);
  });

  it('settings: validated, audited, effective immediately; maintenance mode pauses customers but not staff', async () => {
    const admin = await makeStaff(ctx, nm('stadm'), 'BANK_ADMIN');
    const csr = await makeStaff(ctx, nm('stcsr'), 'CUSTOMER_SERVICE');
    const a = await makePayer(ctx, nm('stpay'), 5_000_000n);
    const b = await makePayer(ctx, nm('stpayb'), 0n);
    const keys = ['limits.perTransferMinor', 'fees.interbankMinor', 'maintenance.enabled', 'maintenance.message'];
    const reset = async () => { await ctx.prisma.systemConfiguration.deleteMany({ where: { key: { in: keys } } }); MaintenanceService.invalidate(); };
    try {
      const list = (await get(admin.token, '/admin/settings')).body.items;
      expect(list.length).toBeGreaterThanOrEqual(9);
      expect(list.find((s: { key: string }) => s.key === 'fees.interbankMinor')).toMatchObject({ value: 2500, isDefault: true });
      expect((await get(csr.token, '/admin/settings')).status).toBe(403);
      expect((await put(csr.token, '/admin/settings/fees.interbankMinor', { value: 1 })).status).toBe(403);

      expect((await put(admin.token, '/admin/settings/made.up', { value: 1 })).status).toBe(400);
      expect((await put(admin.token, '/admin/settings/fees.interbankMinor', { value: -1 })).status).toBe(400);
      expect((await put(admin.token, '/admin/settings/fees.interbankMinor', { value: 12.5 })).status).toBe(400);
      expect((await put(admin.token, '/admin/settings/fees.interbankMinor', { value: 'free' })).status).toBe(400);
      expect((await put(admin.token, '/admin/settings/maintenance.enabled', { value: 'yes' })).status).toBe(400);
      expect((await put(admin.token, '/admin/settings/maintenance.message', { value: '' })).status).toBe(400);

      // fee change applies to the very next quote
      expect((await put(admin.token, '/admin/settings/fees.interbankMinor', { value: 5000 })).status).toBe(200);
      const q = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', key()).send({ sourceAccountId: a.accountId, destination: { type: 'INTERBANK', bankCode: 'SIM-BANK-A', accountNumber: '12345678901', holderName: 'Kasun F' }, amountMinor: 100_000 });
      expect(q.body.feeMinor).toBe(5000);
      // limit change applies immediately
      await put(admin.token, '/admin/settings/limits.perTransferMinor', { value: 1000 });
      const lim = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', key()).send({ sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 1001 });
      expect(lim.status).toBe(422);
      expect(lim.body.code).toBe('limit_exceeded');
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.changed', subjectId: 'fees.interbankMinor', actorId: admin.id }, orderBy: { createdAt: 'desc' } });
      expect(audit.metadata).toMatchObject({ from: 2500, to: 5000 });

      // maintenance
      expect((await ctx.http.get('/api/v1/system/status')).body).toEqual({ maintenance: false, message: null });
      await put(admin.token, '/admin/settings/maintenance.message', { value: 'Back at 6pm' });
      await put(admin.token, '/admin/settings/maintenance.enabled', { value: true });
      const blocked = await get(a.token, '/accounts');
      expect(blocked.status).toBe(503);
      expect(blocked.body).toMatchObject({ code: 'maintenance', message: 'Back at 6pm' });
      expect((await ctx.http.get('/api/v1/system/status')).body).toEqual({ maintenance: true, message: 'Back at 6pm' }); // public
      expect((await get(admin.token, '/admin/dashboard')).status).toBe(200); // staff unaffected
      expect((await ctx.http.get('/api/v1/health/live')).status).toBe(200);
      await put(admin.token, '/admin/settings/maintenance.enabled', { value: false });
      expect((await get(a.token, '/accounts')).status).toBe(200);
    } finally {
      await reset();
    }
  });

  it('reversal: two-person approval restores balances with an opposite journal and marks the payment reversed', async () => {
    const maker = await makeStaff(ctx, nm('rvm'), 'OPERATIONS_OFFICER');
    const checker = await makeStaff(ctx, nm('rvc'), 'BANK_ADMIN');
    const csr = await makeStaff(ctx, nm('rvcsr'), 'CUSTOMER_SERVICE');
    const a = await makePayer(ctx, nm('rva'), 100_000n);
    const b = await makePayer(ctx, nm('rvb'), 0n);
    const paymentId = await transfer(a, b, 10_000);
    expect(await bal(a.ledgerId)).toBe(90_000n);

    expect((await post(csr.token, '/admin/ledger/reversals', { paymentId, reason: 'Customer error' })).status).toBe(403);
    expect((await post(maker.token, '/admin/ledger/reversals', { paymentId, reason: 'x' })).status).toBe(400);
    const req = await post(maker.token, '/admin/ledger/reversals', { paymentId, reason: 'Duplicate payment reported' });
    expect(req.status).toBe(201);
    expect((await post(maker.token, '/admin/ledger/reversals', { paymentId, reason: 'Duplicate payment reported' })).status).toBe(409); // already pending
    expect(await bal(a.ledgerId)).toBe(90_000n); // requesting moves nothing

    const self = await post(maker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('maker_checker');
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'MAKER_CHECKER_VIOLATION', userId: maker.id } })).toBeGreaterThanOrEqual(1);
    expect(await bal(a.ledgerId)).toBe(90_000n);
    expect((await get(checker.token, '/admin/ledger/approvals')).body.items.find((i: { id: string }) => i.id === req.body.approvalId)).toMatchObject({ kind: 'PAYMENT_REVERSAL', requestedBy: maker.id, amountMinor: 10_000 });

    const ok = await post(checker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' });
    expect(ok.status).toBe(201);
    expect(await bal(a.ledgerId)).toBe(100_000n);
    expect(await bal(b.ledgerId)).toBe(0n);
    const pay = await ctx.prisma.paymentInstruction.findUniqueOrThrow({ where: { id: paymentId } });
    expect(pay.status).toBe('REVERSED');
    const j = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { paymentId }, include: { reversedBy: true } });
    expect(j.status).toBe('REVERSED');
    expect(j.reversedBy?.reference).toBe(`REV-${pay.reference}`);
    expect((await post(checker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' })).status).toBe(409);
    expect((await post(maker.token, '/admin/ledger/reversals', { paymentId, reason: 'Again again' })).status).toBe(409); // no longer posted
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items.some((x: { title: string }) => x.title === 'Payment reversed')).toBe(true);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(b.token))).body.items.some((x: { title: string }) => x.title === 'Payment reversed')).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ledger.reversal_approved', subjectId: paymentId, actorId: checker.id } })).toBe(1);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('reversal edge cases: cannot reverse what the recipient already spent (request stays pending, can be rejected); loan repayments are not reversible here', async () => {
    const maker = await makeStaff(ctx, nm('rem'), 'BANK_ADMIN');
    const checker = await makeStaff(ctx, nm('rec'), 'BANK_ADMIN');
    const a = await makePayer(ctx, nm('rea'), 100_000n);
    const b = await makePayer(ctx, nm('reb'), 0n);
    const c = await makePayer(ctx, nm('rec2'), 0n);
    const paymentId = await transfer(a, b, 10_000);
    await transfer(b, c, 10_000); // b spends it all
    const req = await post(maker.token, '/admin/ledger/reversals', { paymentId, reason: 'Mistaken transfer' });
    const fail = await post(checker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' });
    expect(fail.status).toBe(409);
    expect(fail.body.message).toMatch(/stays pending/i);
    expect((await ctx.prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.body.approvalId } })).status).toBe('PENDING'); // rolled back with the transaction
    expect((await ctx.prisma.paymentInstruction.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('POSTED');
    expect(await bal(a.ledgerId)).toBe(90_000n);
    expect((await post(checker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'REJECT' })).status).toBe(400);
    const rej = await post(checker.token, `/admin/ledger/approvals/${req.body.approvalId}/decision`, { decision: 'REJECT', reason: 'Recipient already spent the funds' });
    expect(rej.body.status).toBe('REJECTED');

    const loanPay = await ctx.prisma.paymentInstruction.create({ data: { reference: nm('LPAY'), kind: 'LOAN_INSTALMENT', status: 'POSTED', initiatorId: a.id, sourceAccountId: a.accountId, destination: { settle: 'LOAN', name: 'x', accountMasked: 'x', bank: 'x' }, amountMinor: 100n, currency: 'LKR', postedAt: new Date() } });
    const lr = await post(maker.token, '/admin/ledger/reversals', { paymentId: loanPay.id, reason: 'Wrong loan' });
    expect(lr.status).toBe(409);
    expect(lr.body.code).toBe('not_reversible_kind');
    const pendingPay = await ctx.prisma.paymentInstruction.create({ data: { reference: nm('PPAY'), kind: 'INTERNAL_TRANSFER', status: 'AWAITING_AUTHORIZATION', initiatorId: a.id, sourceAccountId: a.accountId, destination: { settle: 'INTERNAL', name: 'x', accountMasked: 'x', bank: 'x' }, amountMinor: 100n, currency: 'LKR' } });
    expect((await post(maker.token, '/admin/ledger/reversals', { paymentId: pendingPay.id, reason: 'Not posted' })).body.code).toBe('not_reversible');
    expect((await post(maker.token, '/admin/ledger/reversals', { paymentId: '00000000-0000-4000-8000-000000000000', reason: 'Nothing here' })).status).toBe(404);
  });

  it('adjustments: capped, two-person, posted against a system account, never a balance overwrite', async () => {
    const maker = await makeStaff(ctx, nm('adm'), 'OPERATIONS_OFFICER');
    const checker = await makeStaff(ctx, nm('adc'), 'BANK_ADMIN');
    const a = await makePayer(ctx, nm('ada'), 20_000n);
    const adjust = (body: object) => post(maker.token, '/admin/ledger/adjustments', { accountId: a.accountId, direction: 'CREDIT', amountMinor: 5_000, reason: 'Goodwill credit', ...body });

    expect((await adjust({ amountMinor: 0 })).status).toBe(400);
    expect((await adjust({ direction: 'SET' })).status).toBe(400); // there is no "set balance"
    expect((await adjust({ balanceMinor: 1 })).status).toBe(400); // strict body
    expect((await adjust({ amountMinor: 10_000_001 })).status).toBe(422); // above the default cap
    expect((await adjust({ accountId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);

    const credit = await adjust({});
    expect(credit.status).toBe(201);
    expect(await bal(a.ledgerId)).toBe(20_000n);
    expect((await post(maker.token, `/admin/ledger/approvals/${credit.body.approvalId}/decision`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await post(checker.token, `/admin/ledger/approvals/${credit.body.approvalId}/decision`, { decision: 'APPROVE' })).status).toBe(201);
    expect(await bal(a.ledgerId)).toBe(25_000n);
    const j = await ctx.prisma.ledgerJournal.findUniqueOrThrow({ where: { reference: `ADJ-${credit.body.approvalId}` }, include: { postings: true } });
    expect(j.kind).toBe('ADJUSTMENT');
    expect(j.postings).toHaveLength(2);

    const debit = await adjust({ direction: 'DEBIT', amountMinor: 8_000, reason: 'Erroneous credit' });
    await post(checker.token, `/admin/ledger/approvals/${debit.body.approvalId}/decision`, { decision: 'APPROVE' });
    expect(await bal(a.ledgerId)).toBe(17_000n);
    const tooMuch = await adjust({ direction: 'DEBIT', amountMinor: 50_000, reason: 'Clawback' });
    const fail = await post(checker.token, `/admin/ledger/approvals/${tooMuch.body.approvalId}/decision`, { decision: 'APPROVE' });
    expect(fail.status).toBe(409); // would overdraw; nothing posted
    expect(await bal(a.ledgerId)).toBe(17_000n);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ledger.adjustment_approved', actorId: checker.id, subjectId: a.accountId } })).toBe(2);

    await ctx.prisma.systemConfiguration.upsert({ where: { key: 'adjustments.maxMinor' }, update: { value: 1000 }, create: { key: 'adjustments.maxMinor', value: 1000 } });
    try { expect((await adjust({ amountMinor: 1001 })).status).toBe(422); } finally { await ctx.prisma.systemConfiguration.delete({ where: { key: 'adjustments.maxMinor' } }); }
    expect((await ledger.reconcile()).ok).toBe(true);
    const rec = (await get(checker.token, '/admin/ledger/reconciliation')).body;
    expect(rec.ok).toBe(true);
    expect(rec.pendingApprovals).toBeGreaterThanOrEqual(1); // the over-cap one stays pending
  });

  it('reports: real data, validated ranges, permissioned, and a formula-safe audited CSV export', async () => {
    const ops = await makeStaff(ctx, nm('rpo'), 'OPERATIONS_OFFICER');
    const csr = await makeStaff(ctx, nm('rpc'), 'CUSTOMER_SERVICE');
    const a = await makePayer(ctx, nm('rpa'), 100_000n);
    const b = await makePayer(ctx, nm('rpb'), 0n);
    await transfer(a, b, 7_000);
    const tx = (await get(ops.token, '/admin/reports/transactions-daily')).body;
    expect(tx.columns).toEqual(['day', 'posted', 'failed', 'volumeMinor', 'feesMinor']);
    const today = tx.rows[tx.rows.length - 1];
    expect(today.posted).toBeGreaterThanOrEqual(1);
    expect(today.volumeMinor).toBeGreaterThanOrEqual(7_000);
    expect((await get(ops.token, '/admin/reports/customer-growth')).body.rows.length).toBeGreaterThan(0);
    expect((await get(ops.token, '/admin/reports/audit-activity')).status).toBe(200);
    expect((await get(ops.token, '/admin/reports/nope')).status).toBe(404);
    expect((await get(ops.token, '/admin/reports/transactions-daily?from=2020-01-01&to=2026-12-31')).status).toBe(400); // > 366 days
    expect((await get(ops.token, '/admin/reports/transactions-daily?from=2026-12-31&to=2026-01-01')).status).toBe(400);
    expect((await get(ops.token, '/admin/reports/transactions-daily?from=garbage')).status).toBe(400);
    expect((await get(csr.token, '/admin/reports/transactions-daily')).status).toBe(403);
    expect((await get(csr.token, '/admin/reports/transactions-daily/export')).status).toBe(403);

    const ex = await get(ops.token, '/admin/reports/transactions-daily/export');
    expect(ex.status).toBe(200);
    expect(ex.headers['content-type']).toMatch(/text\/csv/);
    expect(ex.headers['content-disposition']).toContain('transactions-daily.csv');
    expect(ex.text.split('\r\n')[0]).toBe('day,posted,failed,volumeMinor,feesMinor');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'report.exported', actorId: ops.id } })).toBe(1);
  });

  it('ledger reconciles after all administrative operations', async () => {
    const r = await ledger.reconcile();
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    const c = await makeCustomer(ctx, nm('last'));
    expect(c.token).toBeTruthy();
  });
});
