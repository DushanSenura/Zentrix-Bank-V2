import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design_system/async_view.dart';
import '../../core/design_system/tokens.dart';
import '../../core/design_system/widgets.dart';
import '../../core/utils/money.dart';
import '../authentication/data/auth_repository.dart';
import '../support/data/support_repository.dart';
import 'search_logic.dart';

/// Recent searches last for this session only; they are never written to disk.
final recentSearchesProvider = NotifierProvider<RecentSearches, List<String>>(RecentSearches.new);

class RecentSearches extends Notifier<List<String>> {
  @override
  List<String> build() => const [];
  void add(String q) => state = [q, ...state.where((x) => x != q)].take(6).toList();
  void clear() => state = const [];
}

class _Remote {
  const _Remote(this.recipients, this.transactions);
  final List<Map<String, dynamic>> recipients;
  final List<TxnItem> transactions;
}

class SearchPage extends ConsumerStatefulWidget {
  const SearchPage({super.key});
  @override
  ConsumerState<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends ConsumerState<SearchPage> {
  final _c = TextEditingController();
  Timer? _debounce;
  String _q = '';
  _Remote? _remote;
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    _c.dispose();
    super.dispose();
  }

  void _changed(String v) {
    _debounce?.cancel();
    setState(() { _q = v.trim(); _error = null; if (_q.length < 2) _remote = null; });
    if (_q.length < 2) return;
    _debounce = Timer(const Duration(milliseconds: 300), () => _fetch(_q));
  }

  Future<void> _fetch(String q) async {
    setState(() => _loading = true);
    try {
      final j = await ref.read(authRepositoryProvider).getJson('/api/v1/search', query: {'q': q});
      if (!mounted || q != _q) return;
      setState(() => _remote = _Remote(
            (j['beneficiaries'] as List).cast<Map<String, dynamic>>(),
            [for (final t in (j['transactions'] as List).cast<Map<String, dynamic>>()) TxnItem(id: t['id'] as String, reference: t['reference'] as String, description: (t['description'] as String?) ?? (t['kind'] as String), amountMinor: (t['amountMinor'] as num).toInt(), postedAt: DateTime.parse(t['postedAt'] as String), accountLabel: (t['accountLabel'] as String?) ?? '', paymentId: t['paymentId'] as String?, currency: (t['currency'] as String?) ?? 'LKR')],
          ));
    } catch (e) {
      if (mounted && q == _q) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _go(String route) {
    ref.read(recentSearchesProvider.notifier).add(_q);
    context.push(route);
  }

  @override
  Widget build(BuildContext context) {
    final recents = ref.watch(recentSearchesProvider);
    final local = matchEntries(_q);
    final features = local.where((e) => !e.isSetting).toList();
    final settings = local.where((e) => e.isSetting).toList();
    final nothing = _q.length >= 2 && !_loading && _error == null && local.isEmpty && (_remote?.recipients.isEmpty ?? true) && (_remote?.transactions.isEmpty ?? true);
    Widget head(String t) => Padding(padding: const EdgeInsets.only(top: ZxSpace.md, bottom: ZxSpace.xs), child: Semantics(header: true, child: Text(t, style: Theme.of(context).textTheme.titleSmall)));
    return ServicePage(
      title: 'Search',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        TextField(controller: _c, autofocus: true, textInputAction: TextInputAction.search, onChanged: _changed, decoration: InputDecoration(labelText: 'Search the app', hintText: 'Payments, settings, people…', prefixIcon: const Icon(Icons.search), suffixIcon: _c.text.isEmpty ? null : IconButton(tooltip: 'Clear', icon: const Icon(Icons.clear), onPressed: () { _c.clear(); _changed(''); }))),
        if (_q.length < 2 && recents.isNotEmpty) ...[
          head('Recent searches'),
          Wrap(spacing: ZxSpace.sm, children: [for (final r in recents) ActionChip(label: Text(r), onPressed: () { _c.text = r; _changed(r); })]),
          TextButton(onPressed: () => ref.read(recentSearchesProvider.notifier).clear(), child: const Text('Clear recent searches')),
        ],
        if (_q.length < 2 && recents.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('Type at least two letters to search features, settings, saved recipients and your transactions.', textAlign: TextAlign.center)),
        if (features.isNotEmpty) ...[head('Features'), for (final e in features) ListTile(title: Text(e.title), subtitle: Text(e.subtitle), trailing: const Icon(Icons.chevron_right), onTap: () => _go(e.route))],
        if (settings.isNotEmpty) ...[head('Settings'), for (final e in settings) ListTile(title: Text(e.title), subtitle: Text(e.subtitle), trailing: const Icon(Icons.chevron_right), onTap: () => _go(e.route))],
        if (_remote != null && _remote!.recipients.isNotEmpty) ...[
          head('Saved recipients'),
          for (final b in _remote!.recipients) ListTile(leading: const Icon(Icons.person_outline), title: Text((b['nickname'] as String?)?.isNotEmpty == true ? b['nickname'] as String : (b['holderName'] as String? ?? 'Recipient')), subtitle: Text('${b['bankName'] ?? b['bankCode'] ?? ''} ${b['accountNumberMasked'] ?? ''}'.trim()), onTap: () => _go('/payments/beneficiaries')),
        ],
        if (_remote != null && _remote!.transactions.isNotEmpty) ...[
          head('Transactions'),
          for (final t in _remote!.transactions) ListTile(title: Text(t.description, maxLines: 1, overflow: TextOverflow.ellipsis), subtitle: Text(t.accountLabel), trailing: Text(formatMinor(t.amountMinor, currency: t.currency, signed: true)), onTap: () => _go('/transactions/${t.id}')),
        ],
        if (_loading) const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Center(child: CircularProgressIndicator())),
        if (_error != null) ZxErrorText(_error!),
        if (nothing) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('Nothing matches. Try another word.', textAlign: TextAlign.center)),
      ]),
    );
  }
}
