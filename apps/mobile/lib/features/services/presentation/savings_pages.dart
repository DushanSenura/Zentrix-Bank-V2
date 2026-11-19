import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../accounts/data/accounts_repository.dart';
import '../../authentication/data/auth_repository.dart';
import '../../payments/data/payments_repository.dart';
import '../../payments/presentation/payment_flow.dart';
import '../data/services_repository.dart';

/// Animated progress bar (instant when reduce-motion is on).
class _Progress extends StatelessWidget {
  const _Progress(this.value, this.color);
  final double value;
  final Color color;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: value.clamp(0, 1)),
        duration: ZxMotion.scaled(context, ZxMotion.large),
        curve: ZxMotion.curve,
        builder: (_, v, _) => LinearProgressIndicator(value: v, minHeight: 10, borderRadius: BorderRadius.circular(5), color: color, backgroundColor: color.withValues(alpha: 0.15)),
      );
}

void _snack(BuildContext context, String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

// ═════════════════════════ savings goals ═════════════════════════
class SavingsPage extends ConsumerWidget {
  const SavingsPage({super.key});

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final name = TextEditingController(), target = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text('New savings goal'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, maxLength: 60, decoration: const InputDecoration(labelText: 'Goal name')),
        TextField(controller: target, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Target (LKR)')),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create'))],
    ));
    final n = name.text.trim();
    final t = parseMajorToMinor(target.text);
    if (ok != true) return;
    if (n.length < 2 || t == null) { if (context.mounted) _snack(context, 'Enter a name and a target amount.'); return; }
    try {
      await ref.read(servicesRepositoryProvider).createGoal(n, t);
      ref.invalidate(goalsProvider);
    } on ApiFailure catch (e) {
      if (context.mounted) _snack(context, e.message);
    }
  }

  Future<void> _move(BuildContext context, WidgetRef ref, GoalModel g, bool contribute) async {
    final accounts = (await ref.read(accountListProvider.future)).items.where((a) => a.status == 'ACTIVE').toList();
    if (accounts.isEmpty || !context.mounted) return;
    final amount = TextEditingController();
    String account = accounts.first.id;
    final ok = await showDialog<bool>(context: context, builder: (ctx) => StatefulBuilder(builder: (ctx, set) => AlertDialog(
      title: Text(contribute ? 'Add to ${g.name}' : 'Withdraw from ${g.name}'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<String>(initialValue: account, isExpanded: true, decoration: InputDecoration(labelText: contribute ? 'From' : 'To'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => set(() => account = v ?? account)),
        TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (LKR)')),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Continue'))],
    )));
    final minor = parseMajorToMinor(amount.text);
    if (ok != true || !context.mounted) return;
    if (minor == null) { _snack(context, 'Enter an amount like 2500.00'); return; }
    final pin = await askPin(context);
    if (pin == null) return;
    try {
      await ref.read(servicesRepositoryProvider).moveGoal(key: newIdempotencyKey(), goalId: g.id, contribute: contribute, accountId: account, amountMinor: minor, pin: pin);
      ref.invalidate(goalsProvider);
      ref.invalidate(accountListProvider);
    } on ApiFailure catch (e) {
      if (context.mounted) _snack(context, e.network ? '${e.message} Check your goal before trying again.' : e.message);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ServicePage(
      title: 'Savings goals',
      fab: FloatingActionButton.extended(onPressed: () => _create(context, ref), icon: const Icon(Icons.add), label: const Text('New goal')),
      body: AsyncView<List<GoalModel>>(
        value: ref.watch(goalsProvider),
        onRetry: () => ref.invalidate(goalsProvider),
        builder: (goals) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(goalsProvider),
          child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
            if (goals.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('No goals yet. Create one and start saving towards it.', textAlign: TextAlign.center)),
            for (final g in goals)
              Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [Expanded(child: Text(g.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))), if (g.status == 'ACHIEVED') Icon(Icons.emoji_events, color: context.zx.success, semanticLabel: 'Goal reached')]),
                const SizedBox(height: ZxSpace.sm),
                Semantics(label: '${g.progressPercent} percent saved', child: _Progress(g.progressPercent / 100, g.status == 'ACHIEVED' ? context.zx.success : context.zx.primary)),
                const SizedBox(height: ZxSpace.xs),
                Text('${formatMinor(g.savedMinor)} of ${formatMinor(g.targetMinor)} (${g.progressPercent}%)'),
                Row(children: [
                  TextButton(onPressed: () => _move(context, ref, g, true), child: const Text('Add money')),
                  if (g.savedMinor > 0) TextButton(onPressed: () => _move(context, ref, g, false), child: const Text('Withdraw')),
                ]),
              ]))),
          ]),
        ),
      ),
    );
  }
}

// ═════════════════════════ budgets ═════════════════════════
class BudgetsPage extends ConsumerWidget {
  const BudgetsPage({super.key});

  Future<void> _edit(BuildContext context, WidgetRef ref, BudgetsView v, {BudgetModel? existing}) async {
    final limit = TextEditingController(text: existing == null ? '' : (existing.limitMinor / 100).toStringAsFixed(2));
    String? category = existing?.category;
    final ok = await showDialog<bool>(context: context, builder: (ctx) => StatefulBuilder(builder: (ctx, set) => AlertDialog(
      title: Text(existing == null ? 'New monthly budget' : 'Edit budget'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<String>(initialValue: category, isExpanded: true, decoration: const InputDecoration(labelText: 'Category'), items: [for (final c in v.categories) DropdownMenuItem(value: c, child: Text(c))], onChanged: existing == null ? (x) => set(() => category = x) : null),
        TextField(controller: limit, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Monthly limit (LKR)')),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save'))],
    )));
    final minor = parseMajorToMinor(limit.text);
    if (ok != true || !context.mounted) return;
    if (category == null || minor == null) { _snack(context, 'Choose a category and enter a limit.'); return; }
    try {
      await ref.read(servicesRepositoryProvider).setBudget(category!, minor);
      ref.invalidate(budgetsProvider);
    } on ApiFailure catch (e) {
      if (context.mounted) _snack(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(budgetsProvider);
    return ServicePage(
      title: 'Budgets',
      fab: data.asData == null ? null : FloatingActionButton.extended(onPressed: () => _edit(context, ref, data.asData!.value), icon: const Icon(Icons.add), label: const Text('New budget')),
      body: AsyncView<BudgetsView>(
        value: data,
        onRetry: () => ref.invalidate(budgetsProvider),
        builder: (v) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(budgetsProvider),
          child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
            const Padding(padding: EdgeInsets.only(bottom: ZxSpace.sm), child: Text('Budgets are your own targets for this month. They never block a payment; the bank warns you at 80% and 100%.')),
            if (v.items.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('No budgets yet.', textAlign: TextAlign.center)),
            for (final b in v.items)
              Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(b.category, style: const TextStyle(fontWeight: FontWeight.w800))),
                  IconButton(tooltip: 'Edit ${b.category} budget', icon: const Icon(Icons.edit_outlined), onPressed: () => _edit(context, ref, v, existing: b)),
                  IconButton(tooltip: 'Delete ${b.category} budget', icon: const Icon(Icons.delete_outline), onPressed: () async {
                    try { await ref.read(servicesRepositoryProvider).deleteBudget(b.category); ref.invalidate(budgetsProvider); } on ApiFailure catch (e) { if (context.mounted) _snack(context, e.message); }
                  }),
                ]),
                Semantics(label: '${b.percentUsed} percent used', child: _Progress(b.percentUsed / 100, b.state == 'OVER' ? context.zx.error : b.state == 'NEAR' ? context.zx.warning : context.zx.success)),
                const SizedBox(height: ZxSpace.xs),
                Text('${formatMinor(b.spentMinor)} of ${formatMinor(b.limitMinor)} · ${b.percentUsed}%${b.state == 'OVER' ? ' — over budget' : b.state == 'NEAR' ? ' — nearly used' : ''}'),
              ]))),
          ]),
        ),
      ),
    );
  }
}

// ═════════════════════════ services hub ═════════════════════════
class ServicesHubPage extends StatelessWidget {
  const ServicesHubPage({super.key});
  @override
  Widget build(BuildContext context) {
    Widget tile(IconData i, String t, String sub, String route) => ListTile(leading: Icon(i), title: Text(t), subtitle: Text(sub), trailing: const Icon(Icons.chevron_right), onTap: () => context.push(route));
    return ServicePage(
      title: 'More services',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        GlassCard(blur: false, padding: EdgeInsets.zero, child: Column(children: [
          tile(Icons.credit_card, 'Cards', 'Debit, virtual and credit cards', '/services/cards'),
          tile(Icons.lock_clock, 'Fixed deposits', 'Lock money away and earn interest', '/services/deposits'),
          tile(Icons.request_quote_outlined, 'Loans', 'Apply, track and repay', '/services/loans'),
          tile(Icons.savings_outlined, 'Savings goals', 'Save towards what matters', '/services/savings'),
          tile(Icons.pie_chart_outline, 'Budgets', 'Monthly spending targets', '/services/budgets'),
        ])),
      ]),
    );
  }
}
