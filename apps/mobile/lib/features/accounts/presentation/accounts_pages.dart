import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../authentication/data/auth_repository.dart';
import '../../authentication/presentation/auth_controller.dart';
import '../../authentication/presentation/auth_pages.dart';
import '../../settings/settings_controller.dart';
import '../../payments/presentation/payments_pages.dart';
import '../data/accounts_repository.dart';

String _err(Object e) => e is ApiFailure ? e.message : 'Something went wrong. Please try again.';

/// Counts up to [minor] (skipped when reduce-motion is on). Shows dots when balances are hidden.
class AmountText extends ConsumerWidget {
  const AmountText(this.minor, {super.key, this.currency = 'LKR', this.style, this.animate = false});
  final int minor;
  final String currency;
  final TextStyle? style;
  final bool animate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hide = ref.watch(settingsProvider.select((s) => s.hideBalances));
    if (hide) return Semantics(label: 'Balance hidden', child: Text(hiddenAmount, style: style));
    if (!animate) return Text(formatMinor(minor, currency: currency), style: style);
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: minor.toDouble()),
      duration: ZxMotion.scaled(context, ZxMotion.large),
      curve: ZxMotion.curve,
      // Display-only interpolation; the final frame is the exact integer from the ledger.
      builder: (_, v, _) => Text(formatMinor(v.round() == minor || (v - minor).abs() < 1 ? minor : v.round(), currency: currency), style: style),
    );
  }
}

// ───────────────────────── dashboard ─────────────────────────
class AccountsHome extends ConsumerWidget {
  const AccountsHome({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(authControllerProvider).me;
    if (me == null) return const SizedBox.shrink();
    final accounts = ref.watch(accountListProvider);
    final hide = ref.watch(settingsProvider.select((s) => s.hideBalances));
    return Scaffold(
      body: ZxBackdrop(
        child: SafeArea(
          child: RefreshIndicator(
            onRefresh: () async { ref.invalidate(accountListProvider); await ref.read(accountListProvider.future).catchError((_) => const AccountList([], 0)); },
            child: ListView(padding: const EdgeInsets.all(ZxSpace.md), physics: const AlwaysScrollableScrollPhysics(), children: [
              Row(children: [
                Expanded(child: Text('Hello, ${me.fullName.split(' ').first}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800))),
                IconButton(tooltip: hide ? 'Show balances' : 'Hide balances', icon: Icon(hide ? Icons.visibility_off_outlined : Icons.visibility_outlined), onPressed: () => ref.read(settingsProvider.notifier).setHideBalances(!hide)),
                Consumer(builder: (_, ref, _) {
                  final unread = ref.watch(unreadCountProvider).asData?.value ?? 0;
                  return IconButton(tooltip: unread > 0 ? 'Notifications, $unread unread' : 'Notifications', icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.notifications_none)), onPressed: () async { await context.push('/notifications'); ref.invalidate(unreadCountProvider); });
                }),
                IconButton(tooltip: 'Profile', icon: const Icon(Icons.account_circle_outlined), onPressed: () => context.push('/profile')),
                IconButton(tooltip: 'Security & settings', icon: const Icon(Icons.shield_outlined), onPressed: () => context.push('/security')),
              ]),
              const SizedBox(height: ZxSpace.md),
              accounts.when(
                loading: () => const _Skeleton(),
                error: (e, _) => GlassCard(child: Column(children: [
                  ZxErrorText(_err(e)),
                  TextButton(onPressed: () => ref.invalidate(accountListProvider), child: const Text('Retry')),
                ])),
                data: (list) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Total balance', style: TextStyle(color: context.zx.textMuted)),
                    const SizedBox(height: ZxSpace.xs),
                    AmountText(list.totalBalanceMinor, animate: true, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: const [FontFeature.tabularFigures()])),
                  ])),
                  const SizedBox(height: ZxSpace.md),
                  if (list.items.isNotEmpty) ...[
                    Row(children: [
                      Expanded(child: FilledButton.icon(style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)), onPressed: () => context.push('/payments/transfer'), icon: const Icon(Icons.send), label: const Text('Send money'))),
                      const SizedBox(width: ZxSpace.sm),
                      Expanded(child: OutlinedButton.icon(style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)), onPressed: () => context.push('/payments'), icon: const Icon(Icons.payments_outlined), label: const Text('Payments'))),
                    ]),
                    const SizedBox(height: ZxSpace.md),
                  ],
                  if (list.items.isEmpty)
                    GlassCard(child: Column(children: [
                      const Text('You have no accounts yet. Open one and the bank will confirm it after you make your opening deposit.', textAlign: TextAlign.center),
                      const SizedBox(height: ZxSpace.md),
                      ZxButton(label: 'Open an account', onPressed: () => context.push('/accounts/open')),
                    ]))
                  else ...[
                    for (final a in list.items) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: _AccountCard(a)),
                    const SizedBox(height: ZxSpace.sm),
                    OutlinedButton.icon(onPressed: () => context.push('/accounts/open'), icon: const Icon(Icons.add), label: const Text('Open another account')),
                  ],
                  OutlinedButton.icon(onPressed: () => context.push('/services'), icon: const Icon(Icons.apps), label: const Text('Cards, deposits, loans & savings')),
                  TextButton(onPressed: () => context.push('/applications'), child: const Text('Account applications')),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();
  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Loading accounts',
        child: Column(children: [for (var i = 0; i < 2; i++) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, child: SizedBox(height: 56, child: DecoratedBox(decoration: BoxDecoration(color: context.zx.textMuted.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(8)))))) ]),
      );
}

class _AccountCard extends StatelessWidget {
  const _AccountCard(this.a);
  final Account a;
  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '${a.title}, ${a.maskedNumber}',
      child: InkWell(
        borderRadius: BorderRadius.circular(ZxSpace.radius),
        onTap: () => context.push('/accounts/${a.id}'),
        child: GlassCard(blur: false, child: Row(children: [
          Icon(a.kind == 'CURRENT' ? Icons.account_balance_outlined : Icons.savings_outlined, color: context.zx.primary),
          const SizedBox(width: ZxSpace.md),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.title, style: const TextStyle(fontWeight: FontWeight.w700)),
            Text(a.maskedNumber, style: TextStyle(color: context.zx.textMuted)),
            if (a.status != 'ACTIVE') Text(a.status[0] + a.status.substring(1).toLowerCase(), style: TextStyle(color: context.zx.warning, fontWeight: FontWeight.w700)),
          ])),
          AmountText(a.balanceMinor, currency: a.currency, style: const TextStyle(fontWeight: FontWeight.w700)),
        ])),
      ),
    );
  }
}

// ───────────────────────── detail + history ─────────────────────────
const _statusExplain = {
  'FROZEN': 'This account is frozen: money can come in, but nothing can be sent. Contact the bank for details.',
  'SUSPENDED': 'This account is suspended. Contact the bank for details.',
  'CLOSED': 'This account is closed.',
};

class AccountDetailPage extends ConsumerStatefulWidget {
  const AccountDetailPage({super.key, required this.id});
  final String id;
  @override
  ConsumerState<AccountDetailPage> createState() => _AccountDetailPageState();
}

class _AccountDetailPageState extends ConsumerState<AccountDetailPage> {
  final List<Txn> _items = [];
  String? _cursor;
  bool _loading = false, _loaded = false;
  Object? _error;

  @override
  void initState() { super.initState(); Future.microtask(() => _more(reset: true)); }

  Future<void> _more({bool reset = false}) async {
    if (_loading) return;
    setState(() { _loading = true; _error = null; if (reset) { _items.clear(); _cursor = null; } });
    try {
      final page = await ref.read(accountsRepositoryProvider).transactions(widget.id, cursor: _cursor);
      if (!mounted) return;
      setState(() { _items.addAll(page.items); _cursor = page.nextCursor; _loaded = true; });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final acc = ref.watch(accountProvider(widget.id));
    return Scaffold(
      appBar: AppBar(title: Text(acc.asData?.value.title ?? 'Account')),
      body: ZxBackdrop(
        child: SafeArea(
          child: acc.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(accountProvider(widget.id)), child: const Text('Retry'))])),
            data: (a) => RefreshIndicator(
              onRefresh: () async { ref.invalidate(accountProvider(widget.id)); await _more(reset: true); },
              child: ListView(padding: const EdgeInsets.all(ZxSpace.md), physics: const AlwaysScrollableScrollPhysics(), children: [
                GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${a.productName} · ${a.maskedNumber}', style: TextStyle(color: context.zx.textMuted)),
                  const SizedBox(height: ZxSpace.xs),
                  AmountText(a.balanceMinor, currency: a.currency, animate: true, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
                  if (a.interestRateBps > 0) Text('Interest ${(a.interestRateBps / 100).toStringAsFixed(2)}% p.a. (indicative)', style: TextStyle(color: context.zx.textMuted)),
                  if (_statusExplain[a.status] != null) ...[const SizedBox(height: ZxSpace.sm), Text(_statusExplain[a.status]!, style: TextStyle(color: context.zx.warning, fontWeight: FontWeight.w600))],
                ])),
                const SizedBox(height: ZxSpace.md),
                Text('Recent activity', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: ZxSpace.sm),
                if (!_loaded && _error == null) const Center(child: Padding(padding: EdgeInsets.all(ZxSpace.lg), child: CircularProgressIndicator())),
                if (_error != null) GlassCard(blur: false, child: Column(children: [ZxErrorText(_err(_error!)), TextButton(onPressed: () => _more(reset: _items.isEmpty), child: const Text('Retry'))])),
                if (_loaded && _items.isEmpty && _error == null) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('No transactions yet.', textAlign: TextAlign.center)),
                for (final t in _items) _TxnTile(t, a.currency),
                if (_cursor != null) TextButton(onPressed: _loading ? null : _more, child: Text(_loading ? 'Loading…' : 'Load more')),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _TxnTile extends ConsumerWidget {
  const _TxnTile(this.t, this.currency);
  final Txn t;
  final String currency;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inflow = t.amountMinor > 0;
    final d = t.postedAt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return Padding(
      padding: const EdgeInsets.only(bottom: ZxSpace.sm),
      child: GlassCard(blur: false, padding: const EdgeInsets.all(ZxSpace.md), child: Row(children: [
        Icon(inflow ? Icons.south_west : Icons.north_east, color: inflow ? context.zx.success : context.zx.text),
        const SizedBox(width: ZxSpace.md),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(t.description ?? t.kind.replaceAll('_', ' ').toLowerCase(), style: const TextStyle(fontWeight: FontWeight.w600)),
          Text('${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)} · ${t.reference}', style: TextStyle(color: context.zx.textMuted, fontSize: 12)),
        ])),
        _Signed(t.amountMinor, currency, inflow ? context.zx.success : null),
      ])),
    );
  }
}

class _Signed extends ConsumerWidget {
  const _Signed(this.minor, this.currency, this.color);
  final int minor;
  final String currency;
  final Color? color;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hide = ref.watch(settingsProvider.select((s) => s.hideBalances));
    return Text(hide ? hiddenAmount : formatMinor(minor, currency: currency, signed: true), style: TextStyle(fontWeight: FontWeight.w700, color: color));
  }
}

// ───────────────────────── open account / applications ─────────────────────────
class OpenAccountPage extends ConsumerStatefulWidget {
  const OpenAccountPage({super.key});
  @override
  ConsumerState<OpenAccountPage> createState() => _OpenAccountPageState();
}

class _OpenAccountPageState extends ConsumerState<OpenAccountPage> with FormRunner {
  String? _code;
  final _nick = TextEditingController();
  bool _sent = false;
  @override
  void dispose() { _nick.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final products = ref.watch(productsProvider);
    if (_sent) {
      return AuthScaffold(title: 'Application received', back: true, children: [
        const Text('The bank will review your application. Once approved and your opening deposit is received, the account appears here automatically.', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.md),
        ZxButton(label: 'Track applications', onPressed: () => context.go('/applications')),
      ]);
    }
    return AuthScaffold(title: 'Open an account', back: true, children: [
      products.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Column(children: [ZxErrorText(_err(e)), TextButton(onPressed: () => ref.invalidate(productsProvider), child: const Text('Retry'))]),
        data: (list) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          RadioGroup<String>(
            groupValue: _code,
            onChanged: (v) => setState(() => _code = v),
            child: Column(children: [
              for (final p in list)
                RadioListTile<String>(
                  value: p.code,
                  title: Text(p.name),
                  subtitle: Text('Minimum opening deposit ${formatMinor(p.minOpeningMinor)}${p.interestRateBps > 0 ? ' · ${(p.interestRateBps / 100).toStringAsFixed(2)}% p.a.' : ''}'),
                ),
            ]),
          ),
          const SizedBox(height: ZxSpace.sm),
          TextField(controller: _nick, maxLength: 40, decoration: const InputDecoration(labelText: 'Nickname (optional)')),
          ZxErrorText(error),
          ZxButton(label: 'Submit application', loading: busy, onPressed: _code == null ? null : () => run(() async {
            await ref.read(accountsRepositoryProvider).apply(_code!, _nick.text.trim());
            ref.invalidate(applicationsProvider);
            if (mounted) setState(() => _sent = true);
          })),
        ]),
      ),
    ]);
  }
}

const _appStatus = {
  'SUBMITTED': 'Received',
  'UNDER_REVIEW': 'Under review',
  'APPROVED': 'Approved',
  'REJECTED': 'Not approved',
  'CANCELLED': 'Cancelled',
};

class ApplicationsPage extends ConsumerWidget {
  const ApplicationsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final apps = ref.watch(applicationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Account applications')),
      body: ZxBackdrop(
        child: SafeArea(
          child: apps.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(applicationsProvider), child: const Text('Retry'))])),
            data: (items) => RefreshIndicator(
              onRefresh: () async => ref.invalidate(applicationsProvider),
              child: ListView(padding: const EdgeInsets.all(ZxSpace.md), physics: const AlwaysScrollableScrollPhysics(), children: [
                if (items.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('No applications yet.', textAlign: TextAlign.center)),
                for (final a in items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: ZxSpace.sm),
                    child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(a.productName, style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text(_appStatus[a.status] ?? a.status, style: TextStyle(color: a.status == 'REJECTED' ? context.zx.error : context.zx.textMuted, fontWeight: FontWeight.w600)),
                      if (a.decisionReason != null) Text(a.decisionReason!),
                    ])),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
