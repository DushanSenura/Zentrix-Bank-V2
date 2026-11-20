import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design_system/async_view.dart';
import '../../core/design_system/tokens.dart';
import '../../core/design_system/widgets.dart';
import '../../core/utils/money.dart';
import '../accounts/data/accounts_repository.dart';
import '../payments/presentation/payment_flow.dart' show askPin;
import 'fx_repository.dart';

/// Exchange between the customer's rupee account and one of their foreign-currency accounts. The bank quotes an exact amount valid for
/// one minute; confirming needs the app PIN. Foreign to foreign goes through rupees.
class ExchangePage extends ConsumerStatefulWidget {
  const ExchangePage({super.key});
  @override
  ConsumerState<ExchangePage> createState() => _ExchangePageState();
}

class _ExchangePageState extends ConsumerState<ExchangePage> {
  String? _from;
  String? _to;
  final _amount = TextEditingController();
  FxQuote? _quote;
  bool _busy = false;
  String? _error;
  Timer? _tick;
  int _secondsLeft = 0;

  @override
  void dispose() {
    _tick?.cancel();
    _amount.dispose();
    super.dispose();
  }

  void _startCountdown(FxQuote q) {
    _tick?.cancel();
    _secondsLeft = q.expiresAt.difference(DateTime.now()).inSeconds.clamp(0, 60);
    _tick = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _secondsLeft = q.expiresAt.difference(DateTime.now()).inSeconds.clamp(0, 60));
      if (_secondsLeft <= 0) t.cancel();
    });
  }

  Future<void> _getQuote() async {
    final minor = parseMajorToMinor(_amount.text);
    if (minor == null || minor <= 0) return setState(() => _error = 'Enter the amount you want to exchange.');
    if (_from == null || _to == null) return setState(() => _error = 'Choose both accounts.');
    setState(() { _busy = true; _error = null; _quote = null; });
    try {
      final q = await ref.read(fxRepositoryProvider).quote(fromAccountId: _from!, toAccountId: _to!, amountMinor: minor);
      if (!mounted) return;
      setState(() => _quote = q);
      _startCountdown(q);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirm() async {
    final q = _quote!;
    final pin = await askPin(context);
    if (pin == null || !mounted) return;
    setState(() { _busy = true; _error = null; });
    try {
      final r = await ref.read(fxRepositoryProvider).exchange(q.token, pin);
      ref.invalidate(accountListProvider);
      _tick?.cancel();
      if (!mounted) return;
      setState(() { _quote = null; _amount.clear(); });
      await showDialog<void>(context: context, builder: (c) => AlertDialog(title: const Text('Exchange complete'), content: Text('You exchanged ${formatMinor(r.fromMinor, currency: r.fromCurrency)} for ${formatMinor(r.toMinor, currency: r.toCurrency)}.'), actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))]));
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider);
    return ServicePage(
      title: 'Currency exchange',
      body: AsyncView<AccountList>(
        value: accounts,
        onRetry: () => ref.invalidate(accountListProvider),
        builder: (list) {
          final active = list.items.where((a) => a.status == 'ACTIVE').toList();
          final hasForeign = active.any((a) => a.currency != 'LKR');
          final hasLkr = active.any((a) => a.currency == 'LKR');
          if (!hasForeign || !hasLkr) {
            return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
              const _RatesCard(),
              const SizedBox(height: ZxSpace.md),
              GlassCard(blur: false, child: Column(children: [
                Text(!hasLkr ? 'You need an active rupee account to exchange money.' : 'Open a foreign-currency account (US dollar, euro or pound) to exchange money. The bank opens it after a quick review, with no deposit.', textAlign: TextAlign.center),
                const SizedBox(height: ZxSpace.md),
                ZxButton(label: 'Open an account', onPressed: () => context.push('/accounts/open')),
              ])),
            ]);
          }
          Account? find(String? id) => active.where((a) => a.id == id).firstOrNull;
          final from = find(_from);
          String label(Account a) => '${a.title} · ${a.currency} · ${formatMinor(a.balanceMinor, currency: a.currency)}';
          return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            const _RatesCard(),
            const SizedBox(height: ZxSpace.md),
            GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              DropdownButtonFormField<String>(initialValue: _from, isExpanded: true, decoration: const InputDecoration(labelText: 'From'), items: [for (final a in active) DropdownMenuItem(value: a.id, child: Text(label(a), overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() { _from = v; _quote = null; if (_to == v) _to = null; })),
              const SizedBox(height: ZxSpace.md),
              DropdownButtonFormField<String>(
                initialValue: _to, isExpanded: true, decoration: const InputDecoration(labelText: 'To'),
                items: [for (final a in active) if (a.id != _from && (from == null || (a.currency != from.currency && (a.currency == 'LKR' || from.currency == 'LKR')))) DropdownMenuItem(value: a.id, child: Text(label(a), overflow: TextOverflow.ellipsis))],
                onChanged: (v) => setState(() { _to = v; _quote = null; }),
              ),
              const SizedBox(height: ZxSpace.md),
              TextField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: from == null ? 'Amount to exchange' : 'Amount to exchange (${from.currency})', prefixText: from == null ? null : '${from.currency} '), onChanged: (_) => setState(() => _quote = null)),
              if (_error != null) ZxErrorText(_error!),
              const SizedBox(height: ZxSpace.md),
              ZxButton(label: _busy && _quote == null ? 'Getting quote…' : 'Get quote', onPressed: _busy ? null : _getQuote),
            ])),
            if (_quote != null) ...[
              const SizedBox(height: ZxSpace.md),
              GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Your quote', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: ZxSpace.xs),
                Text('${formatMinor(_quote!.fromMinor, currency: _quote!.fromCurrency)} → ${formatMinor(_quote!.toMinor, currency: _quote!.toCurrency)}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                Text('Rate: ${_quote!.rateText}'),
                const SizedBox(height: ZxSpace.xs),
                Semantics(liveRegion: true, child: Text(_secondsLeft > 0 ? 'Valid for $_secondsLeft more seconds' : 'This quote has expired. Get a new one.', style: TextStyle(fontSize: 12, color: _secondsLeft > 0 ? null : Theme.of(context).colorScheme.error))),
                const SizedBox(height: ZxSpace.md),
                ZxButton(label: _busy ? 'Exchanging…' : 'Confirm exchange', onPressed: _busy || _secondsLeft <= 0 ? null : _confirm),
              ])),
            ],
          ]);
        },
      ),
    );
  }
}

class _RatesCard extends ConsumerWidget {
  const _RatesCard();
  @override
  Widget build(BuildContext context, WidgetRef ref) => ref.watch(fxRatesProvider).when(
        loading: () => const SizedBox.shrink(),
        error: (e, _) => GlassCard(blur: false, child: Text(errorText(e))),
        data: (r) => GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Today\'s rates', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: ZxSpace.xs),
          for (final x in r.items)
            Semantics(
              label: '${x.currency}: you pay ${x.youPay.toStringAsFixed(2)} rupees per unit to buy, and get ${x.youGet.toStringAsFixed(2)} rupees per unit when you sell',
              excludeSemantics: true,
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(children: [
                SizedBox(width: 48, child: Text(x.currency, style: const TextStyle(fontWeight: FontWeight.w700))),
                Expanded(child: Text('Buy ${x.youPay.toStringAsFixed(2)}  ·  Sell ${x.youGet.toStringAsFixed(2)}')),
                const Text('LKR', style: TextStyle(fontSize: 12)),
              ])),
            ),
          const SizedBox(height: ZxSpace.xs),
          Text(r.note, style: const TextStyle(fontSize: 12)),
        ])),
      );
}
