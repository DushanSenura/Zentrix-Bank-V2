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
import '../../payments/presentation/payment_flow.dart';
import '../data/services_repository.dart';

final cardDetailProvider = FutureProvider.autoDispose.family<BankCard, String>((ref, id) => ref.watch(servicesRepositoryProvider).card(id), retry: (_, _) => null);

IconData _kindIcon(String k) => switch (k) { 'VIRTUAL' => Icons.credit_card_outlined, 'CREDIT' => Icons.credit_score, _ => Icons.payment };
String _kindLabel(String k) => switch (k) { 'VIRTUAL' => 'Virtual card', 'CREDIT' => 'Credit card', _ => 'Debit card' };

class CardsPage extends ConsumerWidget {
  const CardsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ServicePage(
      navIndex: 2,
      title: 'Cards',
      fab: FloatingActionButton.extended(onPressed: () => context.push('/services/cards/request'), icon: const Icon(Icons.add_card), label: const Text('Request a card')),
      body: AsyncView<List<BankCard>>(
        value: ref.watch(cardsProvider),
        onRetry: () => ref.invalidate(cardsProvider),
        builder: (cards) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(cardsProvider),
          child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
            if (cards.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('You have no cards yet. Request one and the bank will review it.', textAlign: TextAlign.center)),
            for (final c in cards)
              Padding(
                padding: const EdgeInsets.only(bottom: ZxSpace.sm),
                child: Semantics(
                  button: true,
                  label: '${_kindLabel(c.kind)}, ${c.statusText}',
                  child: InkWell(
                    borderRadius: BorderRadius.circular(ZxSpace.radius),
                    onTap: () => context.push('/services/cards/${c.id}'),
                    child: GlassCard(blur: false, child: Row(children: [
                      Icon(_kindIcon(c.kind), size: 32, color: context.zx.primary),
                      const SizedBox(width: ZxSpace.md),
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(_kindLabel(c.kind), style: const TextStyle(fontWeight: FontWeight.w700)),
                        Text(c.maskedNumber ?? 'Number issued after approval', style: TextStyle(color: context.zx.textMuted)),
                        Text(c.statusText, style: TextStyle(fontWeight: FontWeight.w700, color: c.status == 'ACTIVE' ? context.zx.success : (c.status == 'BLOCKED' || c.status == 'REJECTED') ? context.zx.error : context.zx.warning)),
                      ])),
                      if (c.expiry != null) Text(c.expiry!),
                    ])),
                  ),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

class RequestCardPage extends ConsumerStatefulWidget {
  const RequestCardPage({super.key});
  @override
  ConsumerState<RequestCardPage> createState() => _RequestCardPageState();
}

class _RequestCardPageState extends ConsumerState<RequestCardPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  String _kind = 'VIRTUAL';
  String? _account, _branch;
  final _income = TextEditingController(), _employment = TextEditingController(), _limit = TextEditingController();
  bool _sent = false;
  @override
  void dispose() { for (final c in [_income, _employment, _limit]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status == 'ACTIVE').toList() ?? const <Account>[];
    final branches = ref.watch(branchesProvider).asData?.value.where((b) => b.type == 'BRANCH').toList() ?? const <BranchInfo>[];
    if (accounts.isNotEmpty) _account ??= accounts.first.id;
    if (_sent) {
      return AuthScaffold(title: 'Request received', back: true, children: [
        Text(_kind == 'VIRTUAL' ? 'The bank will review your request. A virtual card is activated by the bank as soon as it is approved — you will get a notification.' : 'The bank will review your request. We will tell you when your card is being prepared and when it is ready to collect.', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.md),
        ZxButton(label: 'Back to cards', onPressed: () { ref.invalidate(cardsProvider); context.pop(); }),
      ]);
    }
    return AuthScaffold(title: 'Request a card', back: true, children: [
      Form(key: _form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(spacing: ZxSpace.sm, children: [for (final (k, l) in [('VIRTUAL', 'Virtual'), ('DEBIT', 'Debit'), ('CREDIT', 'Credit')]) ChoiceChip(label: Text(l), selected: _kind == k, onSelected: (_) => setState(() => _kind = k))]),
        const SizedBox(height: ZxSpace.md),
        DropdownButtonFormField<String>(initialValue: _account, isExpanded: true, decoration: const InputDecoration(labelText: 'Linked account'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _account = v)),
        if (_kind == 'DEBIT') ...[
          const SizedBox(height: ZxSpace.md),
          DropdownButtonFormField<String>(initialValue: _branch, isExpanded: true, decoration: const InputDecoration(labelText: 'Collect from branch'), validator: (v) => v == null ? 'Choose a branch' : null, items: [for (final b in branches) DropdownMenuItem(value: b.id, child: Text('${b.name}, ${b.city}'))], onChanged: (v) => setState(() => _branch = v)),
          const Padding(padding: EdgeInsets.only(top: ZxSpace.sm), child: Text('The bank prepares a debit card for about 5 days. Bring your ID to collect it, then activate it here.')),
        ],
        if (_kind == 'CREDIT') ...[
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _income, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Monthly income (LKR)'), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount' : null),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _employment, decoration: const InputDecoration(labelText: 'Employment'), validator: (v) => (v ?? '').trim().length < 2 ? 'Required' : null),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _limit, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Requested limit (LKR)'), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount' : null),
          const Padding(padding: EdgeInsets.only(top: ZxSpace.sm), child: Text('The bank decides the limit. This request is not an approval.')),
        ],
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Continue', loading: busy, onPressed: _account == null ? null : () async {
          if (!_form.currentState!.validate()) return;
          final pin = await askPin(context);
          if (pin == null) return;
          run(() async {
            await ref.read(servicesRepositoryProvider).requestCard(
                  kind: _kind, accountId: _account!, pin: pin, branchId: _kind == 'DEBIT' ? _branch : null,
                  application: _kind == 'CREDIT' ? {'monthlyIncomeMinor': parseMajorToMinor(_income.text)!, 'employment': _employment.text.trim(), 'requestedLimitMinor': parseMajorToMinor(_limit.text)!} : null,
                );
            if (mounted) setState(() => _sent = true);
          });
        }),
      ])),
    ]);
  }
}

class CardDetailPage extends ConsumerStatefulWidget {
  const CardDetailPage({super.key, required this.id});
  final String id;
  @override
  ConsumerState<CardDetailPage> createState() => _CardDetailPageState();
}

class _CardDetailPageState extends ConsumerState<CardDetailPage> {
  String? _error;
  final _limit = TextEditingController();
  String? _limitFor;

  @override
  void dispose() { _limit.dispose(); super.dispose(); }

  Future<void> _do(Future<void> Function() f) async {
    setState(() => _error = null);
    try {
      await f();
      ref.invalidate(cardDetailProvider(widget.id));
      ref.invalidate(cardsProvider);
    } on ApiFailure catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _control(BankCard c, {int? limit, bool? online, bool? international, bool? contactless}) async {
    final cur = c.controls!;
    final loosening = (limit != null && limit > cur.dailyLimitMinor) || online == true && !cur.online || international == true && !cur.international || contactless == true && !cur.contactless;
    String? pin;
    if (loosening) { pin = await askPin(context); if (pin == null) return; }
    await _do(() => ref.read(servicesRepositoryProvider).setControls(c.id, {'dailyLimitMinor': ?limit, 'onlineEnabled': ?online, 'internationalEnabled': ?international, 'contactlessEnabled': ?contactless, 'pin': ?pin}));
  }

  Future<void> _activate(BankCard c) async {
    final cardPin = TextEditingController();
    final chosen = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Choose a card PIN'),
      content: TextField(controller: cardPin, obscureText: true, keyboardType: TextInputType.number, maxLength: 4, decoration: const InputDecoration(labelText: '4-digit card PIN')),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, cardPin.text), child: const Text('Next'))],
    ));
    if (chosen == null || !RegExp(r'^\d{4}$').hasMatch(chosen) || !mounted) return;
    final pin = await askPin(context);
    if (pin == null) return;
    await _do(() => ref.read(servicesRepositoryProvider).activateCard(c.id, pin, chosen));
  }

  Future<void> _lost(BankCard c) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('Report card lost or stolen?'),
      content: const Text('The card will be blocked permanently. This cannot be undone.'),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Block card'))],
    ));
    if (ok != true || !mounted) return;
    final pin = await askPin(context);
    if (pin == null) return;
    await _do(() => ref.read(servicesRepositoryProvider).reportLost(c.id, pin));
  }

  @override
  Widget build(BuildContext context) {
    final card = ref.watch(cardDetailProvider(widget.id));
    return ServicePage(
      title: 'Card',
      body: AsyncView<BankCard>(
        value: card,
        onRetry: () => ref.invalidate(cardDetailProvider(widget.id)),
        builder: (c) {
          final ctl = c.controls;
          if (ctl != null && _limitFor != '${c.id}:${ctl.dailyLimitMinor}') { _limitFor = '${c.id}:${ctl.dailyLimitMinor}'; _limit.text = (ctl.dailyLimitMinor / 100).toStringAsFixed(2); }
          return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Icon(_kindIcon(c.kind), color: context.zx.primary), const SizedBox(width: ZxSpace.sm), Text(_kindLabel(c.kind), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)), const Spacer(), Text(c.network)]),
              const SizedBox(height: ZxSpace.md),
              Text(c.maskedNumber ?? '•••• •••• •••• ----', style: const TextStyle(fontSize: 20, letterSpacing: 1.5, fontWeight: FontWeight.w700)),
              const SizedBox(height: ZxSpace.xs),
              Text('${c.holderName}${c.expiry != null ? '   ${c.expiry}' : ''}'),
              const SizedBox(height: ZxSpace.sm),
              Text(c.statusText, style: TextStyle(fontWeight: FontWeight.w800, color: c.status == 'ACTIVE' ? context.zx.success : (c.status == 'BLOCKED' || c.status == 'REJECTED') ? context.zx.error : context.zx.warning)),
              if (c.creditLimitMinor != null) Text('Credit limit ${formatMinor(c.creditLimitMinor!)}'),
            ])),
            const SizedBox(height: ZxSpace.md),
            ZxErrorText(_error),
            if (c.status == 'PENDING_APPROVAL') const _Note('The bank is reviewing your request.'),
            if (c.status == 'PREPARING') _Note('Your card is being prepared${c.readyOn != null ? ' and should be ready around ${fmtDate(c.readyOn!)}' : ''}.'),
            if (c.status == 'REJECTED') _Note('This request was not approved${c.decisionReason != null ? ': ${c.decisionReason}' : '.'}'),
            if (c.status == 'BLOCKED') const _Note('This card is permanently blocked. Contact support if you need help.'),
            if (c.status == 'READY_TO_COLLECT') ...[
              _Note('Your card is ready${c.collectionBranch != null ? ' at ${c.collectionBranch}' : ''}. Bring your ID. Once you have it in hand, activate it.'),
              ZxButton(label: 'Activate card', onPressed: () => _activate(c)),
            ],
            if (c.usable && ctl != null) ...[
              GlassCard(blur: false, padding: EdgeInsets.zero, child: Column(children: [
                SwitchListTile(title: const Text('Freeze card'), subtitle: const Text('Temporarily stop all use. You can unfreeze any time.'), value: c.status == 'FROZEN', onChanged: (v) => _do(() => ref.read(servicesRepositoryProvider).freezeCard(c.id, v))),
                SwitchListTile(title: const Text('Online payments'), value: ctl.online, onChanged: (v) => _control(c, online: v)),
                SwitchListTile(title: const Text('International payments'), value: ctl.international, onChanged: (v) => _control(c, international: v)),
                SwitchListTile(title: const Text('Contactless'), value: ctl.contactless, onChanged: (v) => _control(c, contactless: v)),
                Padding(padding: const EdgeInsets.all(ZxSpace.md), child: Row(children: [
                  Expanded(child: TextField(controller: _limit, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: 'Daily limit (LKR)', helperText: 'Bank maximum ${formatMinor(ctl.maxDailyLimitMinor)}'))),
                  const SizedBox(width: ZxSpace.sm),
                  FilledButton(onPressed: () { final m = parseMajorToMinor(_limit.text); if (m == null) { setState(() => _error = 'Enter a valid limit'); return; } _control(c, limit: m); }, child: const Text('Save')),
                ])),
              ])),
              const SizedBox(height: ZxSpace.md),
              TextButton.icon(onPressed: () => _lost(c), icon: Icon(Icons.report_gmailerrorred, color: context.zx.error), label: Text('Report lost or stolen', style: TextStyle(color: context.zx.error))),
            ],
            const _Note('Limits are stored with the bank and shown here. In this simulation no card purchases are made, so limits are not yet enforced at a merchant.'),
          ]);
        },
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(bottom: ZxSpace.md), child: Text(text, style: TextStyle(color: context.zx.textMuted)));
}
