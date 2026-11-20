import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../accounts/data/accounts_repository.dart';
import '../../payments/data/payments_repository.dart' show DraftRequest;
import '../data/support_repository.dart';
import 'support_pages.dart' show ReceiptActions;

String _day(DateTime d) {
  final l = d.toLocal();
  return '${l.year}-${l.month.toString().padLeft(2, '0')}-${l.day.toString().padLeft(2, '0')}';
}

String _heading(DateTime d) {
  final now = DateTime.now();
  final l = d.toLocal();
  final today = DateTime(now.year, now.month, now.day);
  final that = DateTime(l.year, l.month, l.day);
  final diff = today.difference(that).inDays;
  return diff == 0 ? 'Today' : diff == 1 ? 'Yesterday' : _day(d);
}

// ═════════════════════════ transaction history ═════════════════════════
class HistoryPage extends ConsumerStatefulWidget {
  const HistoryPage({super.key});
  @override
  ConsumerState<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends ConsumerState<HistoryPage> {
  final _search = TextEditingController();
  TxnFilter _filter = const TxnFilter();
  final _items = <TxnItem>[];
  String? _cursor;
  bool _loading = true;
  bool _more = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({bool append = false}) async {
    setState(() { if (append) { _more = true; } else { _loading = true; _items.clear(); _cursor = null; } _error = null; });
    try {
      final page = await ref.read(supportRepositoryProvider).transactions(_filter.copyWith(q: _search.text), cursor: append ? _cursor : null);
      if (!mounted) return;
      setState(() { _items.addAll(page.items); _cursor = page.nextCursor; });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() { _loading = false; _more = false; });
    }
  }

  void _apply(TxnFilter f) { setState(() => _filter = f); _load(); }

  Future<void> _moreFilters() async {
    final f = await showModalBottomSheet<TxnFilter>(context: context, isScrollControlled: true, builder: (_) => _FilterSheet(initial: _filter));
    if (f != null) _apply(f);
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider).asData?.value.items ?? const <Account>[];
    final children = <Widget>[];
    String? last;
    for (final t in _items) {
      final h = _heading(t.postedAt);
      if (h != last) { children.add(Padding(padding: const EdgeInsets.only(top: ZxSpace.sm), child: Semantics(header: true, child: Text(h, style: Theme.of(context).textTheme.titleSmall)))); last = h; }
      children.add(Semantics(
        label: '${t.description}, ${formatMinor(t.amountMinor, signed: true)}, ${_day(t.postedAt)}',
        child: ListTile(
          title: Text(t.description, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(t.accountLabel),
          trailing: Text(formatMinor(t.amountMinor, signed: true), style: TextStyle(fontWeight: FontWeight.w600, color: t.amountMinor < 0 ? Theme.of(context).colorScheme.error : null)),
          onTap: () => context.push('/transactions/${t.id}'),
        ),
      ));
    }
    if (_cursor != null) children.add(Padding(padding: const EdgeInsets.all(ZxSpace.md), child: OutlinedButton(onPressed: _more ? null : () => _load(append: true), child: Text(_more ? 'Loading…' : 'Load more'))));

    return ServicePage(
      navIndex: 3,
      title: 'Transaction history',
      actions: [IconButton(tooltip: 'Statements', icon: const Icon(Icons.description_outlined), onPressed: () => context.push('/statements'))],
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 0),
          child: Column(children: [
            TextField(controller: _search, textInputAction: TextInputAction.search, decoration: const InputDecoration(labelText: 'Search description or reference', prefixIcon: Icon(Icons.search)), onSubmitted: (_) => _load()),
            const SizedBox(height: ZxSpace.sm),
            DropdownButtonFormField<String?>(
              initialValue: _filter.accountId, isExpanded: true, decoration: const InputDecoration(labelText: 'Account'),
              items: [const DropdownMenuItem(value: null, child: Text('All accounts')), for (final a in accounts) DropdownMenuItem(value: a.id, child: Text(a.title, overflow: TextOverflow.ellipsis))],
              onChanged: (v) => _apply(v == null ? _filter.copyWith(clearAccount: true) : _filter.copyWith(accountId: v)),
            ),
            const SizedBox(height: ZxSpace.sm),
            Wrap(spacing: ZxSpace.sm, runSpacing: ZxSpace.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
              for (final (label, value) in const [('All', null), ('Money in', 'IN'), ('Money out', 'OUT')])
                ChoiceChip(label: Text(label), selected: _filter.direction == value, onSelected: (_) => _apply(value == null ? _filter.copyWith(clearDirection: true) : _filter.copyWith(direction: value))),
              ActionChip(avatar: const Icon(Icons.tune, size: 18), label: Text(_filter.advancedCount > 0 ? 'More filters (${_filter.advancedCount})' : 'More filters'), onPressed: _moreFilters),
            ]),
            if (_filter.advancedCount > 0)
              Align(alignment: Alignment.centerLeft, child: Wrap(spacing: ZxSpace.xs, children: [
                if (_filter.category != null) InputChip(label: Text(_filter.category!), onDeleted: () => _apply(_filter.copyWith(clearCategory: true))),
                if (_filter.from != null || _filter.to != null) InputChip(label: Text('${_filter.from != null ? _day(_filter.from!) : '…'} to ${_filter.to != null ? _day(_filter.to!) : '…'}'), onDeleted: () => _apply(_filter.copyWith(clearDates: true))),
                if (_filter.minMinor != null || _filter.maxMinor != null) InputChip(label: Text('${_filter.minMinor != null ? formatMinor(_filter.minMinor!) : 'any'} – ${_filter.maxMinor != null ? formatMinor(_filter.maxMinor!) : 'any'}'), onDeleted: () => _apply(_filter.copyWith(clearAmounts: true))),
              ])),
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_error!), TextButton(onPressed: _load, child: const Text('Try again'))]))
                  : _items.isEmpty
                      ? const Center(child: Text('No transactions match.'))
                      : ListView(padding: const EdgeInsets.all(ZxSpace.md), children: children),
        ),
      ]),
    );
  }
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.initial});
  final TxnFilter initial;
  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late String? _category = widget.initial.category;
  late DateTime? _from = widget.initial.from;
  late DateTime? _to = widget.initial.to;
  late final _min = TextEditingController(text: widget.initial.minMinor == null ? '' : (widget.initial.minMinor! / 100).toStringAsFixed(2));
  late final _max = TextEditingController(text: widget.initial.maxMinor == null ? '' : (widget.initial.maxMinor! / 100).toStringAsFixed(2));
  String? _error;

  @override
  void dispose() {
    _min.dispose();
    _max.dispose();
    super.dispose();
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final r = await showDateRangePicker(context: context, firstDate: DateTime(now.year - 3), lastDate: now, initialDateRange: _from != null && _to != null ? DateTimeRange(start: _from!, end: _to!) : null);
    if (r != null) setState(() { _from = r.start; _to = r.end; });
  }

  void _apply() {
    final lo = _min.text.trim().isEmpty ? null : parseMajorToMinor(_min.text);
    final hi = _max.text.trim().isEmpty ? null : parseMajorToMinor(_max.text);
    if ((_min.text.trim().isNotEmpty && lo == null) || (_max.text.trim().isNotEmpty && hi == null)) return setState(() => _error = 'Enter amounts like 1500.00.');
    if (lo != null && hi != null && lo > hi) return setState(() => _error = 'The smallest amount must not be more than the largest.');
    var f = widget.initial.copyWith(clearCategory: true, clearDates: true, clearAmounts: true);
    f = f.copyWith(category: _category, from: _from, to: _to, minMinor: lo, maxMinor: hi);
    Navigator.pop(context, f);
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, MediaQuery.of(context).viewInsets.bottom + ZxSpace.md),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Filters', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: ZxSpace.md),
            DropdownButtonFormField<String?>(
              initialValue: _category, isExpanded: true, decoration: const InputDecoration(labelText: 'Category'),
              items: [const DropdownMenuItem(value: null, child: Text('Any category')), for (final c in spendingCategories) DropdownMenuItem(value: c, child: Text(c))],
              onChanged: (v) => setState(() => _category = v),
            ),
            const SizedBox(height: ZxSpace.md),
            OutlinedButton.icon(onPressed: _pickRange, icon: const Icon(Icons.date_range), label: Text(_from == null ? 'Any date' : '${_day(_from!)} to ${_day(_to ?? _from!)}')),
            const SizedBox(height: ZxSpace.md),
            Row(children: [
              Expanded(child: TextField(controller: _min, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Smallest amount (LKR)'))),
              const SizedBox(width: ZxSpace.sm),
              Expanded(child: TextField(controller: _max, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Largest amount (LKR)'))),
            ]),
            if (_error != null) ZxErrorText(_error!),
            const SizedBox(height: ZxSpace.md),
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context, widget.initial.copyWith(clearCategory: true, clearDates: true, clearAmounts: true)), child: const Text('Clear'))),
              const SizedBox(width: ZxSpace.sm),
              Expanded(child: FilledButton(onPressed: _apply, child: const Text('Apply'))),
            ]),
          ]),
        ),
      );
}

// ═════════════════════════ transaction details ═════════════════════════
final transactionDetailProvider = FutureProvider.autoDispose.family<TxnDetail, String>((ref, id) => ref.watch(supportRepositoryProvider).transactionDetail(id));

class TransactionDetailsPage extends ConsumerStatefulWidget {
  const TransactionDetailsPage({super.key, required this.id});
  final String id;
  @override
  ConsumerState<TransactionDetailsPage> createState() => _TransactionDetailsPageState();
}

class _TransactionDetailsPageState extends ConsumerState<TransactionDetailsPage> {
  bool _busy = false;

  Future<void> _repeat(TxnDetail d) async {
    setState(() => _busy = true);
    try {
      final j = await ref.read(supportRepositoryProvider).repeatDraft(d.paymentId!);
      if (!mounted) return;
      // A fresh draft with a new Idempotency-Key: it goes through the normal review and PIN step before any money moves.
      context.push('/payments/review', extra: DraftRequest(sourceAccountId: j['sourceAccountId'] as String, destination: Map<String, dynamic>.from(j['destination'] as Map), amountMinor: (j['amountMinor'] as num).toInt(), note: j['note'] as String?));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(errorText(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Transaction',
        body: AsyncView<TxnDetail>(
          value: ref.watch(transactionDetailProvider(widget.id)),
          onRetry: () => ref.invalidate(transactionDetailProvider(widget.id)),
          builder: (d) {
            Widget row(String k, String? v) => v == null || v.isEmpty ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: Semantics(label: '$k: $v', excludeSemantics: true, child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 120, child: Text(k, style: TextStyle(color: context.zx.textMuted))), Expanded(child: Text(v))])));
            return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
              GlassCard(blur: false, child: Column(children: [
                Text(formatMinor(d.amountMinor, signed: true), style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: d.amountMinor < 0 ? Theme.of(context).colorScheme.error : null)),
                const SizedBox(height: ZxSpace.xs),
                Text(d.description, textAlign: TextAlign.center),
                if (d.status != 'POSTED') Padding(padding: const EdgeInsets.only(top: ZxSpace.xs), child: Chip(label: Text(d.status == 'REVERSED' ? 'Reversed' : d.status.toLowerCase()))),
              ])),
              const SizedBox(height: ZxSpace.md),
              GlassCard(blur: false, child: Column(children: [
                row('Date', _day(d.postedAt)), row('Account', d.accountLabel), row('Category', d.category), row('To / from', d.counterparty), row('Note', d.note),
                row('Fee', d.feeMinor > 0 ? formatMinor(d.feeMinor) : null), row('Reference', d.reference),
              ])),
              if (d.paymentId != null) ReceiptActions(paymentId: d.paymentId!),
              if (d.canRepeat) Padding(padding: const EdgeInsets.only(top: ZxSpace.sm), child: FilledButton.icon(style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)), onPressed: _busy ? null : () => _repeat(d), icon: const Icon(Icons.replay), label: const Text('Repeat this payment'))),
              const Padding(padding: EdgeInsets.only(top: ZxSpace.sm), child: Text('Repeating starts a new payment for you to review and confirm with your PIN.', style: TextStyle(fontSize: 12), textAlign: TextAlign.center)),
            ]);
          },
        ),
      );
}
