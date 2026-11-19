import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../accounts/data/accounts_repository.dart';
import '../../authentication/data/auth_repository.dart';
import '../../authentication/presentation/auth_pages.dart';
import '../../payments/data/payments_repository.dart';
import '../../payments/presentation/payment_flow.dart';
import '../data/services_repository.dart';

String _pct(int bps) => '${(bps / 100).toStringAsFixed(2)}%';
String _term(int m) => m % 12 == 0 && m >= 12 ? '${m ~/ 12} year${m == 12 ? '' : 's'}' : '$m months';

// ═════════════════════════ fixed deposits ═════════════════════════
class DepositsPage extends ConsumerWidget {
  const DepositsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ServicePage(
      title: 'Fixed deposits',
      fab: FloatingActionButton.extended(onPressed: () => context.push('/services/deposits/open'), icon: const Icon(Icons.add), label: const Text('Open a deposit')),
      body: AsyncView<FdList>(
        value: ref.watch(depositsProvider),
        onRetry: () => ref.invalidate(depositsProvider),
        builder: (d) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(depositsProvider),
          child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
            GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Locked away', style: TextStyle(color: context.zx.textMuted)),
              Text(formatMinor(d.lockedMinor), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              Text('Interest still to come ${formatMinor(d.interestToComeMinor)}', style: TextStyle(color: context.zx.textMuted)),
            ])),
            const SizedBox(height: ZxSpace.md),
            if (d.items.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('You have no fixed deposits yet.', textAlign: TextAlign.center)),
            for (final f in d.items) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: _DepositCard(f)),
          ]),
        ),
      ),
    );
  }
}

class _DepositCard extends ConsumerWidget {
  const _DepositCard(this.f);
  final FixedDepositModel f;
  static const _renewal = {'WITH_INTEREST': 'Renews with interest', 'WITHOUT_INTEREST': 'Renews without interest', 'PAYOUT': 'Paid out at maturity'};

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text(formatMinor(f.principalMinor), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18))),
        Text(f.status == 'ACTIVE' ? '${f.daysLeft} days left' : f.status[0] + f.status.substring(1).toLowerCase(), style: TextStyle(color: context.zx.textMuted)),
      ]),
      Text('${_term(f.termMonths)} at ${_pct(f.rateBps)} · ${f.reference}'),
      Text('Matures ${fmtDate(f.maturityDate)} · ${_renewal[f.renewal]}${f.renewalCount > 0 ? ' · renewed ${f.renewalCount}×' : ''}', style: TextStyle(color: context.zx.textMuted)),
      if (f.status == 'ACTIVE') ...[
        Text('At maturity ${formatMinor(f.maturityValueMinor)} (interest ${formatMinor(f.interestAtMaturityMinor)})'),
        const SizedBox(height: ZxSpace.xs),
        f.closureRequested
            ? Text('Early closure requested — waiting for the bank', style: TextStyle(color: context.zx.warning, fontWeight: FontWeight.w700))
            : TextButton(onPressed: () => _closure(context, ref), child: const Text('Request early closure')),
      ],
    ]));
  }

  Future<void> _closure(BuildContext context, WidgetRef ref) async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Close this deposit early?'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('The bank reviews early closures and a penalty reduces your interest. Nothing changes until the bank approves.'),
        TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (optional)')),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send request'))],
    ));
    final text = reason.text;
    if (ok != true) return;
    try {
      await ref.read(servicesRepositoryProvider).requestClosure(f.id, text);
      ref.invalidate(depositsProvider);
    } on ApiFailure catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}

class OpenDepositPage extends ConsumerStatefulWidget {
  const OpenDepositPage({super.key});
  @override
  ConsumerState<OpenDepositPage> createState() => _OpenDepositPageState();
}

class _OpenDepositPageState extends ConsumerState<OpenDepositPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  final _amount = TextEditingController();
  String? _account;
  int? _termMonths;
  String _renewal = 'WITH_INTEREST';
  // One key per attempt. If the connection drops we KEEP it, so a retry can never open a second deposit.
  final String _key = newIdempotencyKey();
  bool _unknown = false;
  FixedDepositModel? _done;

  @override
  void dispose() { _amount.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status == 'ACTIVE').toList() ?? const <Account>[];
    final rates = ref.watch(fdRatesProvider);
    if (accounts.isNotEmpty) _account ??= accounts.first.id;
    if (_done != null) {
      return AuthScaffold(title: 'Deposit opened', back: false, children: [
        Text('${formatMinor(_done!.principalMinor)} for ${_term(_done!.termMonths)} at ${_pct(_done!.rateBps)}.\nReference ${_done!.reference}', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.sm),
        const Text('The terms are fixed and cannot be changed after opening.', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.md),
        ZxButton(label: 'Done', onPressed: () { ref.invalidate(depositsProvider); ref.invalidate(accountListProvider); context.pop(); }),
      ]);
    }
    final amount = parseMajorToMinor(_amount.text);
    return AuthScaffold(title: 'Open a fixed deposit', back: true, children: [
      if (_unknown) GlassCard(blur: false, child: Column(children: [
        const Text('We could not confirm whether your deposit was opened. Check your deposits before trying again — retrying is safe and will not open a second deposit.', textAlign: TextAlign.center),
        TextButton(onPressed: () { ref.invalidate(depositsProvider); context.pop(); }, child: const Text('Check my deposits')),
      ])),
      Form(key: _form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<String>(initialValue: _account, isExpanded: true, decoration: const InputDecoration(labelText: 'Fund from'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _account = v)),
        const SizedBox(height: ZxSpace.md),
        TextFormField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (LKR)'), onChanged: (_) => setState(() {}), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount like 100000.00' : null),
        const SizedBox(height: ZxSpace.md),
        rates.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => Column(children: [ZxErrorText(errorText(e)), TextButton(onPressed: () => ref.invalidate(fdRatesProvider), child: const Text('Retry'))]),
          data: (list) => DropdownButtonFormField<int>(initialValue: _termMonths, isExpanded: true, decoration: const InputDecoration(labelText: 'Term'), validator: (v) => v == null ? 'Choose a term' : null, items: [for (final r in list) DropdownMenuItem(value: r.termMonths, child: Text('${_term(r.termMonths)} · ${_pct(r.rateBps)}'))], onChanged: (v) => setState(() => _termMonths = v)),
        ),
        const SizedBox(height: ZxSpace.md),
        RadioGroup<String>(groupValue: _renewal, onChanged: (v) => setState(() => _renewal = v ?? _renewal), child: const Column(children: [
          RadioListTile<String>(value: 'WITH_INTEREST', title: Text('Renew with interest'), subtitle: Text('Principal and interest start a new term together')),
          RadioListTile<String>(value: 'WITHOUT_INTEREST', title: Text('Renew without interest'), subtitle: Text('Interest is paid to your account; the principal renews')),
          RadioListTile<String>(value: 'PAYOUT', title: Text('Pay out at maturity'), subtitle: Text('Principal and interest return to your account')),
        ])),
        if (amount != null && _termMonths != null)
          FutureBuilder<FdQuote>(
            key: ValueKey('$amount-$_termMonths'),
            future: ref.read(servicesRepositoryProvider).fdQuote(amount, _termMonths!),
            builder: (context, s) => s.hasData
                ? GlassCard(blur: false, child: Text('Interest ${formatMinor(s.data!.interestMinor)} · value at maturity ${formatMinor(s.data!.maturityValueMinor)} on ${fmtDate(s.data!.maturityDate)}. Simple interest; the bank confirms the rate when you open.'))
                : s.hasError ? Text(errorText(s.error!), style: TextStyle(color: context.zx.error)) : const LinearProgressIndicator(),
          ),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Open deposit', loading: busy, onPressed: _account == null ? null : () async {
          if (!_form.currentState!.validate()) return;
          final pin = await askPin(context);
          if (pin == null) return;
          setState(() => _unknown = false);
          await run(() async {
            try {
              final d = await ref.read(servicesRepositoryProvider).openDeposit(key: _key, accountId: _account!, amountMinor: amount!, termMonths: _termMonths!, renewal: _renewal, pin: pin);
              if (mounted) setState(() => _done = d);
            } on ApiFailure catch (e) {
              if (e.network && mounted) setState(() => _unknown = true); // keep _key: a retry is idempotent
              rethrow;
            }
          });
        }),
      ])),
    ]);
  }
}

// ═════════════════════════ loans ═════════════════════════
class LoansPage extends ConsumerWidget {
  const LoansPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loans = ref.watch(loansProvider);
    final apps = ref.watch(loanApplicationsProvider);
    return ServicePage(
      title: 'Loans',
      fab: FloatingActionButton.extended(onPressed: () => context.push('/services/loans/apply'), icon: const Icon(Icons.request_quote_outlined), label: const Text('Apply for a loan')),
      body: RefreshIndicator(
        onRefresh: () async { ref.invalidate(loansProvider); ref.invalidate(loanApplicationsProvider); },
        child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
          Text('My loans', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: ZxSpace.sm),
          loans.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Column(children: [ZxErrorText(errorText(e)), TextButton(onPressed: () => ref.invalidate(loansProvider), child: const Text('Retry'))]),
            data: (list) => list.isEmpty ? const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Text('You have no loans.')) : Column(children: [
              for (final l in list) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: InkWell(
                borderRadius: BorderRadius.circular(ZxSpace.radius),
                onTap: () => context.push('/services/loans/${l.id}'),
                child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${l.productName} · ${l.reference}', style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text('Outstanding ${formatMinor(l.outstandingMinor)}', style: const TextStyle(fontWeight: FontWeight.w800)),
                  if (l.status == 'CLOSED') Text('Fully repaid', style: TextStyle(color: context.zx.success)) else if (l.nextDue != null) Text('Next instalment ${formatMinor(l.nextDueMinor!)} due ${fmtDate(l.nextDue!)}${l.nextStatus == 'OVERDUE' ? ' — OVERDUE' : ''}', style: TextStyle(color: l.nextStatus == 'OVERDUE' ? context.zx.error : context.zx.textMuted)),
                ])),
              )),
            ]),
          ),
          const SizedBox(height: ZxSpace.md),
          Text('Applications', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: ZxSpace.sm),
          apps.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Column(children: [ZxErrorText(errorText(e)), TextButton(onPressed: () => ref.invalidate(loanApplicationsProvider), child: const Text('Retry'))]),
            data: (list) => list.isEmpty ? const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Text('No applications.')) : Column(children: [
              for (final a in list) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${a.productName} · ${formatMinor(a.amountMinor)}', style: const TextStyle(fontWeight: FontWeight.w700)),
                Text(a.statusText, style: TextStyle(fontWeight: FontWeight.w700, color: a.status == 'REJECTED' ? context.zx.error : context.zx.primary)),
                for (final (label, done) in a.steps) Row(children: [Icon(done ? Icons.check_circle : Icons.radio_button_unchecked, size: 16, color: done ? context.zx.success : context.zx.textMuted), const SizedBox(width: 6), Text(label)]),
                if (a.decisionReason != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(a.decisionReason!)),
              ]))),
            ]),
          ),
        ]),
      ),
    );
  }
}

class LoanApplyPage extends ConsumerStatefulWidget {
  const LoanApplyPage({super.key});
  @override
  ConsumerState<LoanApplyPage> createState() => _LoanApplyPageState();
}

class _LoanApplyPageState extends ConsumerState<LoanApplyPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  final _amount = TextEditingController(), _term = TextEditingController(), _income = TextEditingController(), _employment = TextEditingController(), _purpose = TextEditingController();
  String? _product, _account;
  bool _consent = false, _sent = false;
  @override
  void dispose() { for (final c in [_amount, _term, _income, _employment, _purpose]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final products = ref.watch(loanProductsProvider);
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status == 'ACTIVE').toList() ?? const <Account>[];
    if (accounts.isNotEmpty) _account ??= accounts.first.id;
    if (_sent) {
      return AuthScaffold(title: 'Application received', back: true, children: [
        const Text('Your application is with the bank. Nothing has been approved and no money has moved. Track its progress under Loans.', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.md),
        ZxButton(label: 'Back to loans', onPressed: () { ref.invalidate(loanApplicationsProvider); context.pop(); }),
      ]);
    }
    final amount = parseMajorToMinor(_amount.text);
    final term = int.tryParse(_term.text);
    final income = parseMajorToMinor(_income.text);
    return AuthScaffold(title: 'Apply for a loan', back: true, children: [
      products.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Column(children: [ZxErrorText(errorText(e)), TextButton(onPressed: () => ref.invalidate(loanProductsProvider), child: const Text('Retry'))]),
        data: (list) {
          final p = list.where((x) => x.code == _product).firstOrNull;
          return Form(key: _form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<String>(initialValue: _product, isExpanded: true, decoration: const InputDecoration(labelText: 'Loan type'), validator: (v) => v == null ? 'Choose a loan type' : null, items: [for (final x in list) DropdownMenuItem(value: x.code, child: Text('${x.name} · ${_pct(x.rateBps)}'))], onChanged: (v) => setState(() => _product = v)),
            if (p != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${formatMinor(p.minAmountMinor)} – ${formatMinor(p.maxAmountMinor)}, ${p.minTermMonths}–${p.maxTermMonths} months', style: TextStyle(color: context.zx.textMuted))),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (LKR)'), onChanged: (_) => setState(() {}), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount' : null),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _term, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Term (months)'), onChanged: (_) => setState(() {}), validator: (v) => int.tryParse(v ?? '') == null ? 'Enter the number of months' : null),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _income, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Monthly income (LKR)'), onChanged: (_) => setState(() {}), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter your monthly income' : null),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _employment, decoration: const InputDecoration(labelText: 'Employment'), validator: (v) => (v ?? '').trim().length < 2 ? 'Required' : null),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _purpose, maxLength: 200, decoration: const InputDecoration(labelText: 'Purpose (optional)')),
            DropdownButtonFormField<String>(initialValue: _account, isExpanded: true, decoration: const InputDecoration(labelText: 'Pay the money into'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _account = v)),
            if (_product != null && amount != null && term != null)
              FutureBuilder<LoanEstimate>(
                key: ValueKey('$_product-$amount-$term-$income'),
                future: ref.read(servicesRepositoryProvider).loanEstimate(_product!, amount, term, income),
                builder: (context, s) {
                  if (s.hasError) return Padding(padding: const EdgeInsets.only(top: ZxSpace.md), child: Text(errorText(s.error!), style: TextStyle(color: context.zx.error)));
                  if (!s.hasData) return const Padding(padding: EdgeInsets.only(top: ZxSpace.md), child: LinearProgressIndicator());
                  final e = s.data!;
                  return Padding(padding: const EdgeInsets.only(top: ZxSpace.md), child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Estimated instalment ${formatMinor(e.emiMinor)} a month', style: const TextStyle(fontWeight: FontWeight.w800)),
                    Text('Total interest ${formatMinor(e.totalInterestMinor)} · total payable ${formatMinor(e.totalPayableMinor)}'),
                    if (e.band != null) Text('Affordability: ${e.band!.toLowerCase()}'),
                    if (e.disclaimer != null) Text(e.disclaimer!, style: TextStyle(color: context.zx.textMuted)),
                  ])));
                },
              ),
            CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, value: _consent, onChanged: (v) => setState(() => _consent = v ?? false), title: const Text('I confirm my details are correct and agree to the bank checking them.')),
            ZxErrorText(error),
            ZxButton(label: 'Submit application', loading: busy, onPressed: !_consent || _account == null ? null : () {
              if (!_form.currentState!.validate()) return;
              run(() async {
                await ref.read(servicesRepositoryProvider).applyLoan(code: _product!, amountMinor: amount!, termMonths: term!, incomeMinor: income!, employment: _employment.text.trim(), purpose: _purpose.text.trim(), accountId: _account!);
                if (mounted) setState(() => _sent = true);
              });
            }),
          ]));
        },
      ),
    ]);
  }
}

class LoanDetailPage extends ConsumerWidget {
  const LoanDetailPage({super.key, required this.id});
  final String id;

  Future<void> _pay(BuildContext context, WidgetRef ref, int amountMinor) async {
    final acc = (await ref.read(accountListProvider.future)).items.where((a) => a.status == 'ACTIVE').firstOrNull;
    if (acc == null) return;
    if (!context.mounted) return;
    await context.push('/payments/review', extra: DraftRequest(sourceAccountId: acc.id, destination: {'type': 'LOAN', 'loanId': id}, amountMinor: amountMinor, note: 'Loan repayment'));
    ref.invalidate(loanDetailProvider(id));
    ref.invalidate(loansProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ServicePage(
      title: 'Loan',
      body: AsyncView<LoanDetailModel>(
        value: ref.watch(loanDetailProvider(id)),
        onRetry: () => ref.invalidate(loanDetailProvider(id)),
        builder: (d) {
          final s = d.summary;
          return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${s.productName} · ${s.reference}', style: TextStyle(color: context.zx.textMuted)),
              Text('Outstanding ${formatMinor(s.outstandingMinor)}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              Text('${formatMinor(s.principalMinor)} at ${_pct(d.rateBps)} over ${d.termMonths} months'),
              if (s.status == 'CLOSED') Text('Fully repaid', style: TextStyle(color: context.zx.success, fontWeight: FontWeight.w800)),
            ])),
            if (s.status == 'ACTIVE') ...[
              const SizedBox(height: ZxSpace.md),
              if (s.nextDueMinor != null) ZxButton(label: 'Pay next instalment · ${formatMinor(s.nextDueMinor!)}', onPressed: () => _pay(context, ref, s.nextDueMinor!)),
              const SizedBox(height: ZxSpace.sm),
              OutlinedButton(
                onPressed: () async {
                  try {
                    final total = await ref.read(servicesRepositoryProvider).settlementMinor(id);
                    if (!context.mounted) return;
                    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
                      title: const Text('Settle this loan'),
                      content: Text('Paying ${formatMinor(total)} today closes the loan. Interest for future months is waived.'),
                      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Continue'))],
                    ));
                    if (ok == true && context.mounted) await _pay(context, ref, total);
                  } on ApiFailure catch (e) {
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
                  }
                },
                child: const Text('Settle in full'),
              ),
            ],
            const SizedBox(height: ZxSpace.md),
            Text('Repayment schedule', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: ZxSpace.sm),
            for (final r in d.schedule)
              Padding(padding: const EdgeInsets.only(bottom: ZxSpace.xs), child: GlassCard(blur: false, padding: const EdgeInsets.all(ZxSpace.md), child: Row(children: [
                SizedBox(width: 28, child: Text('${r.no}', style: const TextStyle(fontWeight: FontWeight.w800))),
                Expanded(child: Text('${fmtDate(r.dueDate)}\nPrincipal ${formatMinor(r.principalMinor)} · Interest ${formatMinor(r.interestMinor)}')),
                Text(switch (r.status) { 'PAID' => 'Paid', 'CLOSED_EARLY' => 'Settled', 'OVERDUE' => 'Overdue', 'PARTIAL' => 'Part paid', _ => 'Due' }, style: TextStyle(fontWeight: FontWeight.w700, color: r.status == 'OVERDUE' ? context.zx.error : r.status == 'PAID' || r.status == 'CLOSED_EARLY' ? context.zx.success : null)),
              ]))),
          ]);
        },
      ),
    );
  }
}
