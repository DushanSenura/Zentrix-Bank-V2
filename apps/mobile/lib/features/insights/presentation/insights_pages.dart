import 'dart:math' as math;

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
          if (s.categories.isNotEmpty) _DonutCard(s),
          const _CashFlowCard(),
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

const _palette = [Color(0xFF155EEF), Color(0xFF39C7F4), Color(0xFF13A77A), Color(0xFFE5A138), Color(0xFFDF4B5B), Color(0xFF8B5CF6), Color(0xFF64748B)];

/// Spending split by category as a donut. The legend repeats every figure as text, so the chart is never the only carrier of information.
class _DonutCard extends StatelessWidget {
  const _DonutCard(this.s);
  final MonthSummary s;
  @override
  Widget build(BuildContext context) {
    final shown = s.categories.take(6).toList();
    final restMinor = s.categories.skip(6).fold<int>(0, (a, c) => a + c.spentMinor);
    final slices = [for (final c in shown) (c.category, c.spentMinor), if (restMinor > 0) ('Other categories', restMinor)];
    final total = slices.fold<int>(0, (a, e) => a + e.$2);
    return Padding(
      padding: const EdgeInsets.only(bottom: ZxSpace.md),
      child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Spending split', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: ZxSpace.sm),
        Row(children: [
          Semantics(
            label: 'Donut chart: ${slices.map((e) => '${e.$1} ${total == 0 ? 0 : (e.$2 * 100 / total).round()} percent').join(', ')}',
            child: ExcludeSemantics(child: SizedBox(width: 120, height: 120, child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: 1),
              duration: ZxMotion.scaled(context, ZxMotion.large),
              curve: ZxMotion.curve,
              builder: (_, v, _) => CustomPaint(painter: _DonutPainter([for (final e in slices) e.$2.toDouble()], v)),
            ))),
          ),
          const SizedBox(width: ZxSpace.md),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var i = 0; i < slices.length; i++)
              Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(children: [
                Container(width: 10, height: 10, decoration: BoxDecoration(color: _palette[i % _palette.length], shape: BoxShape.circle)),
                const SizedBox(width: ZxSpace.sm),
                Expanded(child: Text(slices[i].$1, overflow: TextOverflow.ellipsis)),
                Text('${total == 0 ? 0 : (slices[i].$2 * 100 / total).round()}%', style: const TextStyle(fontWeight: FontWeight.w600)),
              ])),
          ])),
        ]),
      ])),
    );
  }
}

class _DonutPainter extends CustomPainter {
  _DonutPainter(this.values, this.progress);
  final List<double> values;
  final double progress;
  @override
  void paint(Canvas canvas, Size size) {
    final total = values.fold<double>(0, (a, b) => a + b);
    if (total <= 0) return;
    final rect = Offset.zero & size;
    final stroke = size.width * 0.2;
    var start = -math.pi / 2;
    for (var i = 0; i < values.length; i++) {
      final sweep = values[i] / total * 2 * math.pi * progress;
      canvas.drawArc(rect.deflate(stroke / 2), start, math.max(sweep - 0.02, 0), false, Paint()..style = PaintingStyle.stroke..strokeWidth = stroke..color = _palette[i % _palette.length]);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(_DonutPainter o) => o.progress != progress || o.values != values;
}

/// Money in and spending per month, with the net result as a line.
class _CashFlowCard extends ConsumerWidget {
  const _CashFlowCard();
  @override
  Widget build(BuildContext context, WidgetRef ref) => ref.watch(trendProvider).when(
        loading: () => const SizedBox.shrink(),
        error: (_, _) => const SizedBox.shrink(),
        data: (items) {
          if (items.every((p) => p.spentMinor == 0 && p.moneyInMinor == 0)) return const SizedBox.shrink();
          final cs = Theme.of(context).colorScheme;
          return Padding(
            padding: const EdgeInsets.only(bottom: ZxSpace.md),
            child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Cash flow', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: ZxSpace.xs),
              Wrap(spacing: ZxSpace.md, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Row(mainAxisSize: MainAxisSize.min, children: [Container(width: 10, height: 10, color: const Color(0xFF13A77A)), const SizedBox(width: 4), const Text('Money in', style: TextStyle(fontSize: 12))]),
                Row(mainAxisSize: MainAxisSize.min, children: [Container(width: 10, height: 10, color: const Color(0xFFDF4B5B)), const SizedBox(width: 4), const Text('Spent', style: TextStyle(fontSize: 12))]),
                Row(mainAxisSize: MainAxisSize.min, children: [Container(width: 14, height: 3, color: cs.primary), const SizedBox(width: 4), const Text('Net', style: TextStyle(fontSize: 12))]),
              ]),
              const SizedBox(height: ZxSpace.sm),
              Semantics(
                label: 'Cash flow chart. ${items.map((p) => '${_monthName(p.month)}: in ${formatMinor(p.moneyInMinor)}, spent ${formatMinor(p.spentMinor)}').join('. ')}',
                child: ExcludeSemantics(child: SizedBox(height: 160, width: double.infinity, child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: ZxMotion.scaled(context, ZxMotion.large),
                  curve: ZxMotion.curve,
                  builder: (_, v, _) => CustomPaint(painter: _CashFlowPainter(items, v, cs.primary, cs.onSurface.withValues(alpha: 0.2))),
                ))),
              ),
              Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [for (final p in items) Text(_months[int.parse(p.month.substring(5)) - 1], style: const TextStyle(fontSize: 11))]),
            ])),
          );
        },
      );
}

class _CashFlowPainter extends CustomPainter {
  _CashFlowPainter(this.items, this.progress, this.lineColor, this.grid);
  final List<TrendPoint> items;
  final double progress;
  final Color lineColor;
  final Color grid;
  @override
  void paint(Canvas canvas, Size size) {
    final n = items.length;
    if (n == 0) return;
    final peak = items.fold<int>(1, (m, p) => math.max(m, math.max(p.moneyInMinor, p.spentMinor)));
    final lowest = items.fold<int>(0, (m, p) => math.min(m, p.moneyInMinor - p.spentMinor));
    final range = (peak - lowest).toDouble();
    double y(num v) => size.height - ((v - lowest) / range) * size.height;
    canvas.drawLine(Offset(0, y(0)), Offset(size.width, y(0)), Paint()..color = grid..strokeWidth = 1);
    final slot = size.width / n;
    final bar = slot * 0.28;
    final inPaint = Paint()..color = const Color(0xFF13A77A);
    final outPaint = Paint()..color = const Color(0xFFDF4B5B);
    final path = Path();
    final zero = y(0);
    for (var i = 0; i < n; i++) {
      final cx = slot * i + slot / 2;
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(cx - bar - 1, zero - (zero - y(items[i].moneyInMinor)) * progress, cx - 1, zero), const Radius.circular(3)), inPaint);
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(cx + 1, zero - (zero - y(items[i].spentMinor)) * progress, cx + bar + 1, zero), const Radius.circular(3)), outPaint);
      final ny = zero - (zero - y(items[i].moneyInMinor - items[i].spentMinor)) * progress;
      if (i == 0) { path.moveTo(cx, ny); } else { path.lineTo(cx, ny); }
    }
    canvas.drawPath(path, Paint()..color = lineColor..style = PaintingStyle.stroke..strokeWidth = 2.5..strokeJoin = StrokeJoin.round);
  }

  @override
  bool shouldRepaint(_CashFlowPainter o) => o.progress != progress || o.items != items;
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
