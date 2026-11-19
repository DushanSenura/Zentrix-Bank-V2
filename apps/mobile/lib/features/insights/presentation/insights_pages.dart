import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../data/insights_repository.dart';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
String _monthName(String ym) => '${_months[int.parse(ym.substring(5)) - 1]} ${ym.substring(0, 4)}';

/// A horizontal bar whose length animates in (instantly when reduce-motion is on).
class _Bar extends StatelessWidget {
  const _Bar(this.fraction, this.color);
  final double fraction;
  final Color color;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: fraction.clamp(0, 1)),
        duration: ZxMotion.scaled(context, ZxMotion.large),
        curve: ZxMotion.curve,
        builder: (_, v, _) => LinearProgressIndicator(value: v, minHeight: 8, borderRadius: BorderRadius.circular(4), color: color, backgroundColor: color.withValues(alpha: 0.15)),
      );
}

class InsightsPage extends ConsumerStatefulWidget {
  const InsightsPage({super.key});
  @override
  ConsumerState<InsightsPage> createState() => _InsightsPageState();
}

class _InsightsPageState extends ConsumerState<InsightsPage> {
  String? _month; // null = the current month

  @override
  Widget build(BuildContext context) {
    final summary = ref.watch(monthSummaryProvider(_month));
    final cs = Theme.of(context).colorScheme;
    return ServicePage(
      title: 'Spending insights',
      actions: [IconButton(tooltip: 'Ask the help assistant', icon: const Icon(Icons.support_agent), onPressed: () => context.push('/assistant'))],
      body: AsyncView<MonthSummary>(
        value: summary,
        onRetry: () => ref.invalidate(monthSummaryProvider(_month)),
        builder: (s) => ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
          Row(children: [
            IconButton(tooltip: 'Previous month', icon: const Icon(Icons.chevron_left), onPressed: () => setState(() => _month = _shift(s.month, -1))),
            Expanded(child: Text(_monthName(s.month), textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium)),
            IconButton(tooltip: 'Next month', icon: const Icon(Icons.chevron_right), onPressed: _month == null ? null : () => setState(() { final n = _shift(s.month, 1); _month = n == _currentLabel() ? null : n; })),
          ]),
          GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _Row('Money in', formatMinor(s.moneyInMinor)),
            _Row('Spent', formatMinor(s.spentMinor)),
            _Row('Difference', formatMinor(s.netMinor, signed: true)),
            const SizedBox(height: ZxSpace.xs),
            Text(s.spentChangePercent == null ? 'No spending last month to compare with.' : '${s.spentChangePercent!.abs()}% ${s.spentChangePercent! >= 0 ? 'more' : 'less'} spent than last month (${formatMinor(s.previousSpentMinor)}).', style: const TextStyle(fontSize: 12)),
          ])),
          const SizedBox(height: ZxSpace.md),
          Text('By category', style: Theme.of(context).textTheme.titleMedium),
          if (s.categories.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Text('No spending this month.')),
          for (final c in s.categories)
            Semantics(
              label: '${c.category}, ${formatMinor(c.spentMinor)}, ${c.sharePercent} percent of spending',
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: ZxSpace.sm),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [Expanded(child: Text(c.category)), Text(formatMinor(c.spentMinor), style: const TextStyle(fontWeight: FontWeight.w600))]),
                  const SizedBox(height: 4),
                  _Bar(c.sharePercent / 100, cs.primary),
                  if (c.changePercent != null) Text('${c.changePercent! >= 0 ? '+' : ''}${c.changePercent}% vs last month', style: const TextStyle(fontSize: 12)),
                ]),
              ),
            ),
          const SizedBox(height: ZxSpace.md),
          const _TrendCard(),
          const SizedBox(height: ZxSpace.md),
          const _InsightList(),
          const SizedBox(height: ZxSpace.md),
          const _RecurringCard(),
        ]),
      ),
    );
  }

  static String _currentLabel() { final n = DateTime.now(); return '${n.year}-${n.month.toString().padLeft(2, '0')}'; }
  static String _shift(String label, int by) {
    final t = int.parse(label.substring(0, 4)) * 12 + int.parse(label.substring(5)) - 1 + by;
    return '${t ~/ 12}-${((t % 12) + 1).toString().padLeft(2, '0')}';
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: Text(label)), const SizedBox(width: ZxSpace.sm), Flexible(child: Text(value, textAlign: TextAlign.end, style: const TextStyle(fontWeight: FontWeight.w600)))]));
}

class _TrendCard extends ConsumerWidget {
  const _TrendCard();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(trendProvider);
    return t.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(),
      data: (items) {
        final peak = items.fold<int>(1, (m, p) => p.spentMinor > m ? p.spentMinor : m);
        return GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Last 6 months', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: ZxSpace.sm),
          for (final p in items)
            Semantics(
              label: '${_monthName(p.month)}, spent ${formatMinor(p.spentMinor)}',
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(children: [
                SizedBox(width: 44, child: Text(_months[int.parse(p.month.substring(5)) - 1], style: const TextStyle(fontSize: 12))),
                Expanded(child: _Bar(p.spentMinor / peak, Theme.of(context).colorScheme.secondary)),
                SizedBox(width: 96, child: Text(formatMinor(p.spentMinor), textAlign: TextAlign.right, style: const TextStyle(fontSize: 12))),
              ])),
            ),
        ]));
      },
    );
  }
}

class _InsightList extends ConsumerWidget {
  const _InsightList();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = ref.watch(insightsProvider);
    return v.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(),
      data: (d) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('What stands out', style: Theme.of(context).textTheme.titleMedium),
        if (d.narrative != null)
          Padding(padding: const EdgeInsets.only(top: ZxSpace.sm), child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('AI-written summary', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            Text(d.narrative!),
          ]))),
        for (final i in d.items)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Chip(label: Text(i.isEstimate ? 'Estimate' : 'Fact'), visualDensity: VisualDensity.compact),
            title: Text(i.title),
            subtitle: Text(i.detail),
          ),
        Text(d.disclaimer, style: const TextStyle(fontSize: 12)),
      ]),
    );
  }
}

class _RecurringCard extends ConsumerWidget {
  const _RecurringCard();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = ref.watch(recurringProvider);
    return r.when(
      loading: () => const SizedBox.shrink(),
      error: (_, _) => const SizedBox.shrink(),
      data: (items) => items.isEmpty
          ? const SizedBox.shrink()
          : GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Regular payments', style: Theme.of(context).textTheme.titleSmall),
              const Text('Detected from your history, so treat these as estimates.', style: TextStyle(fontSize: 12)),
              for (final p in items) _Row('${p.name} (${p.frequency.toLowerCase()})', formatMinor(p.amountMinor)),
            ])),
    );
  }
}

// ═════════════════════════ help assistant ═════════════════════════
class AssistantPage extends ConsumerStatefulWidget {
  const AssistantPage({super.key});
  @override
  ConsumerState<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends ConsumerState<AssistantPage> {
  final _q = TextEditingController();
  bool _includeData = false;
  bool _busy = false;
  String? _error;
  HelpAnswer? _answer;

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _ask() async {
    if (_q.text.trim().length < 3) return setState(() => _error = 'Ask a question in a few words.');
    setState(() { _busy = true; _error = null; });
    try {
      final a = await ref.read(insightsRepositoryProvider).ask(_q.text.trim(), includeMyData: _includeData);
      if (mounted) setState(() => _answer = a);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = _answer;
    return ServicePage(
      title: 'Help assistant',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Ask about how Zentrix Bank works. Answers come from the bank\'s own help articles. The assistant can explain things but cannot make any change to your accounts.', style: TextStyle(fontSize: 13)),
          const SizedBox(height: ZxSpace.md),
          TextField(controller: _q, maxLength: 500, maxLines: 2, decoration: const InputDecoration(labelText: 'Your question'), onSubmitted: (_) => _ask()),
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Include my spending totals'), subtitle: const Text('Only used if AI answers are on. Totals only, no names or account numbers.'), value: _includeData, onChanged: (v) => setState(() => _includeData = v)),
          if (_error != null) ZxErrorText(_error!),
          ZxButton(label: _busy ? 'Looking…' : 'Ask', onPressed: _busy ? null : _ask),
        ])),
        if (a != null) ...[
          const SizedBox(height: ZxSpace.md),
          if (a.actionNotice != null) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: Text(a.actionNotice!, style: const TextStyle(fontWeight: FontWeight.w600))),
          if (a.answer != null) GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (a.answerIsAi) const Text('AI-written answer, based on the articles below', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            Text(a.answer!),
          ])),
          if (a.sources.isEmpty) const Text('I could not find this in the help articles.'),
          for (final s in a.sources) ExpansionTile(title: Text(s.title), childrenPadding: const EdgeInsets.all(ZxSpace.md), expandedAlignment: Alignment.centerLeft, children: [Text(s.text)]),
          if (a.escalate || a.sources.isEmpty) Padding(padding: const EdgeInsets.only(top: ZxSpace.sm), child: OutlinedButton.icon(onPressed: () => context.push('/support/tickets/new'), icon: const Icon(Icons.forum_outlined), label: const Text('Message the bank'))),
        ],
      ]),
    );
  }
}
