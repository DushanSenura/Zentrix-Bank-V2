import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../accounts/data/accounts_repository.dart';
import '../data/file_sharer.dart';
import '../data/support_repository.dart';

export 'history_pages.dart' show HistoryPage, TransactionDetailsPage;

String _date(DateTime d) {
  final l = d.toLocal();
  return '${l.year}-${l.month.toString().padLeft(2, '0')}-${l.day.toString().padLeft(2, '0')}';
}

void _toast(BuildContext c, String m) => ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(m)));

// ═════════════════════════ statements ═════════════════════════
class StatementsPage extends ConsumerStatefulWidget {
  const StatementsPage({super.key});
  @override
  ConsumerState<StatementsPage> createState() => _StatementsPageState();
}

class _StatementsPageState extends ConsumerState<StatementsPage> {
  String? _account;
  int _days = 30;
  String _format = 'pdf';
  String _lang = 'en';
  bool _busy = false;
  String? _error;

  Future<void> _download(String accountId) async {
    setState(() { _busy = true; _error = null; });
    try {
      final to = DateTime.now();
      final file = await ref.read(supportRepositoryProvider).statement(accountId: accountId, from: _date(to.subtract(Duration(days: _days - 1))), to: _date(to), format: _format, lang: _lang);
      await ref.read(fileSharerProvider).share(file);
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
      title: 'Statements',
      body: AsyncView<AccountList>(
        value: accounts,
        onRetry: () => ref.invalidate(accountListProvider),
        builder: (data) {
          final list = data.items;
          final selected = _account ?? (list.isNotEmpty ? list.first.id : null);
          return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              DropdownButtonFormField<String>(initialValue: selected, isExpanded: true, decoration: const InputDecoration(labelText: 'Account'), items: [for (final a in list) DropdownMenuItem(value: a.id, child: Text('${a.title} ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _account = v)),
              const SizedBox(height: ZxSpace.md),
              DropdownButtonFormField<int>(initialValue: _days, isExpanded: true, decoration: const InputDecoration(labelText: 'Period'), items: const [DropdownMenuItem(value: 30, child: Text('Last 30 days')), DropdownMenuItem(value: 90, child: Text('Last 90 days')), DropdownMenuItem(value: 365, child: Text('Last 12 months'))], onChanged: (v) => setState(() => _days = v ?? 30)),
              const SizedBox(height: ZxSpace.md),
              DropdownButtonFormField<String>(initialValue: _lang, isExpanded: true, decoration: const InputDecoration(labelText: 'Language'), items: [for (final e in statementLanguages.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => _lang = v ?? 'en')),
              const SizedBox(height: ZxSpace.md),
              Wrap(spacing: ZxSpace.sm, children: [for (final (label, value) in const [('PDF', 'pdf'), ('CSV (spreadsheet)', 'csv')]) ChoiceChip(label: Text(label), selected: _format == value, onSelected: (_) => setState(() => _format = value))]),
              const SizedBox(height: ZxSpace.lg),
              ZxButton(label: _busy ? 'Preparing…' : 'Download and share', onPressed: _busy || selected == null ? null : () => _download(selected)),
              if (_error != null) ZxErrorText(_error!),
            ])),
            const SizedBox(height: ZxSpace.md),
            const Text('Statements are produced by the bank from your ledger. A statement covers at most 12 months.', style: TextStyle(fontSize: 12)),
          ]);
        },
      ),
    );
  }
}

/// Shown under a receipt: share the bank's PDF receipt, or report a problem with the payment.
class ReceiptActions extends ConsumerStatefulWidget {
  const ReceiptActions({super.key, required this.paymentId});
  final String paymentId;
  @override
  ConsumerState<ReceiptActions> createState() => _ReceiptActionsState();
}

class _ReceiptActionsState extends ConsumerState<ReceiptActions> {
  bool _busy = false;

  Future<void> _share() async {
    setState(() => _busy = true);
    try {
      await ref.read(fileSharerProvider).share(await ref.read(supportRepositoryProvider).receipt(widget.paymentId, 'en'));
    } catch (e) {
      if (mounted) _toast(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: ZxSpace.md),
        child: Column(children: [
          OutlinedButton.icon(onPressed: _busy ? null : _share, icon: const Icon(Icons.ios_share), label: const Text('Share receipt (PDF)')),
          TextButton.icon(onPressed: () => context.push('/support/report/${widget.paymentId}'), icon: const Icon(Icons.flag_outlined), label: const Text('Report a problem')),
        ]),
      );
}

// ═════════════════════════ report a problem ═════════════════════════
class ReportProblemPage extends ConsumerStatefulWidget {
  const ReportProblemPage({super.key, required this.paymentId});
  final String paymentId;
  @override
  ConsumerState<ReportProblemPage> createState() => _ReportProblemPageState();
}

class _ReportProblemPageState extends ConsumerState<ReportProblemPage> {
  String _reason = 'UNAUTHORISED';
  final _text = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_text.text.trim().length < 10) return setState(() => _error = 'Please describe the problem in a few words (at least 10 characters).');
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(supportRepositoryProvider).reportProblem(paymentId: widget.paymentId, reasonCode: _reason, description: _text.text.trim());
      ref.invalidate(disputesProvider);
      if (!mounted) return;
      _toast(context, 'Thank you. The bank will review your report.');
      context.go('/support/disputes');
    } catch (e) {
      if (mounted) setState(() { _error = errorText(e); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Report a problem',
        body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
          GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Reporting does not refund the payment by itself. The bank reviews every report and tells you the outcome.'),
            const SizedBox(height: ZxSpace.md),
            DropdownButtonFormField<String>(initialValue: _reason, isExpanded: true, decoration: const InputDecoration(labelText: 'What went wrong?'), items: [for (final e in disputeReasons.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => _reason = v ?? 'OTHER')),
            const SizedBox(height: ZxSpace.md),
            TextField(controller: _text, maxLines: 4, maxLength: 1000, decoration: const InputDecoration(labelText: 'Tell us more')),
            if (_error != null) ZxErrorText(_error!),
            const SizedBox(height: ZxSpace.md),
            ZxButton(label: _busy ? 'Sending…' : 'Send report', onPressed: _busy ? null : _submit),
          ])),
        ]),
      );
}

class DisputesPage extends ConsumerWidget {
  const DisputesPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => ServicePage(
        title: 'Problem reports',
        body: AsyncView<List<Dispute>>(
          value: ref.watch(disputesProvider),
          onRetry: () => ref.invalidate(disputesProvider),
          builder: (items) => items.isEmpty
              ? const Center(child: Text('You have not reported any problems.'))
              : ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
                  for (final d in items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: ZxSpace.sm),
                      child: GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${d.reference} · ${disputeReasons[d.reasonCode] ?? d.reasonCode}', style: const TextStyle(fontWeight: FontWeight.w600)),
                        Text(d.statusText),
                        if (d.resolution != null) Padding(padding: const EdgeInsets.only(top: ZxSpace.xs), child: Text('Bank: ${d.resolution}')),
                      ])),
                    ),
                ]),
        ),
      );
}

// ═════════════════════════ help hub, FAQs and tickets ═════════════════════════
class SupportHubPage extends ConsumerWidget {
  const SupportHubPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Widget tile(IconData i, String t, String sub, String route) => ListTile(leading: Icon(i), title: Text(t), subtitle: Text(sub), trailing: const Icon(Icons.chevron_right), onTap: () => context.push(route));
    return ServicePage(
      title: 'Help and support',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        GlassCard(blur: false, padding: EdgeInsets.zero, child: Column(children: [
          tile(Icons.forum_outlined, 'My requests', 'Message the bank', '/support/tickets'),
          tile(Icons.flag_outlined, 'Problem reports', 'Payments you reported', '/support/disputes'),
          tile(Icons.location_on_outlined, 'Branches and ATMs', 'Find us and book a visit', '/support/branches'),
          tile(Icons.history, 'Transaction history', 'Search and filter', '/history'),
          tile(Icons.description_outlined, 'Statements', 'PDF or spreadsheet', '/statements'),
        ])),
        const SizedBox(height: ZxSpace.md),
        Text('Common questions', style: Theme.of(context).textTheme.titleMedium),
        ref.watch(faqsProvider).when(
              loading: () => const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Center(child: CircularProgressIndicator())),
              error: (e, _) => Padding(padding: const EdgeInsets.all(ZxSpace.md), child: Text(errorText(e))),
              data: (faqs) => Column(children: [for (final f in faqs) ExpansionTile(title: Text(f.q), childrenPadding: const EdgeInsets.all(ZxSpace.md), expandedAlignment: Alignment.centerLeft, children: [Text(f.a)])]),
            ),
        const SizedBox(height: ZxSpace.md),
        const Text('Zentrix staff will never ask for your PIN, password or authenticator code.', style: TextStyle(fontSize: 12)),
      ]),
    );
  }
}

class TicketsPage extends ConsumerWidget {
  const TicketsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => ServicePage(
        title: 'My requests',
        fab: FloatingActionButton.extended(onPressed: () => context.push('/support/tickets/new'), icon: const Icon(Icons.add), label: const Text('New request')),
        body: AsyncView<List<Ticket>>(
          value: ref.watch(ticketsProvider),
          onRetry: () => ref.invalidate(ticketsProvider),
          builder: (items) => items.isEmpty
              ? const Center(child: Text('No requests yet.'))
              : ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), children: [
                  for (final t in items) Card(child: ListTile(title: Text(t.subject), subtitle: Text('${t.reference} · ${t.statusText}'), trailing: const Icon(Icons.chevron_right), onTap: () => context.push('/support/tickets/${t.id}'))),
                ]),
        ),
      );
}

class NewTicketPage extends ConsumerStatefulWidget {
  const NewTicketPage({super.key});
  @override
  ConsumerState<NewTicketPage> createState() => _NewTicketPageState();
}

class _NewTicketPageState extends ConsumerState<NewTicketPage> {
  final _subject = TextEditingController();
  final _message = TextEditingController();
  String _category = 'GENERAL';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_subject.text.trim().length < 3 || _message.text.trim().length < 5) return setState(() => _error = 'Please add a subject and a short message.');
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(supportRepositoryProvider).createTicket(subject: _subject.text.trim(), category: _category, message: _message.text.trim());
      ref.invalidate(ticketsProvider);
      if (mounted) context.pop();
    } catch (e) {
      if (mounted) setState(() { _error = errorText(e); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'New request',
        body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
          GlassCard(blur: false, child: Column(children: [
            DropdownButtonFormField<String>(initialValue: _category, isExpanded: true, decoration: const InputDecoration(labelText: 'Topic'), items: [for (final e in ticketCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => _category = v ?? 'GENERAL')),
            const SizedBox(height: ZxSpace.md),
            TextField(controller: _subject, maxLength: 120, decoration: const InputDecoration(labelText: 'Subject')),
            TextField(controller: _message, maxLines: 5, maxLength: 2000, decoration: const InputDecoration(labelText: 'Message')),
            if (_error != null) ZxErrorText(_error!),
            const SizedBox(height: ZxSpace.md),
            ZxButton(label: _busy ? 'Sending…' : 'Send', onPressed: _busy ? null : _send),
          ])),
        ]),
      );
}

class TicketDetailPage extends ConsumerStatefulWidget {
  const TicketDetailPage({super.key, required this.id});
  final String id;
  @override
  ConsumerState<TicketDetailPage> createState() => _TicketDetailPageState();
}

class _TicketDetailPageState extends ConsumerState<TicketDetailPage> {
  final _reply = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_reply.text.trim().isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(supportRepositoryProvider).replyTicket(widget.id, _reply.text.trim());
      _reply.clear();
      ref.invalidate(ticketProvider(widget.id));
      ref.invalidate(ticketsProvider);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Request',
        body: AsyncView<Ticket>(
          value: ref.watch(ticketProvider(widget.id)),
          onRetry: () => ref.invalidate(ticketProvider(widget.id)),
          builder: (t) => ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            Text(t.subject, style: Theme.of(context).textTheme.titleLarge),
            Text('${t.reference} · ${t.statusText}'),
            const SizedBox(height: ZxSpace.md),
            for (final m in t.messages)
              Align(
                alignment: m.from == 'CUSTOMER' ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  margin: const EdgeInsets.only(bottom: ZxSpace.sm), padding: const EdgeInsets.all(ZxSpace.md), constraints: const BoxConstraints(maxWidth: 520),
                  decoration: BoxDecoration(color: (m.from == 'CUSTOMER' ? Theme.of(context).colorScheme.primaryContainer : Theme.of(context).colorScheme.surfaceContainerHighest), borderRadius: BorderRadius.circular(12)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(m.from == 'CUSTOMER' ? 'You' : 'Zentrix Bank', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)), Text(m.body)]),
                ),
              ),
            if (t.status != 'CLOSED') ...[
              TextField(controller: _reply, maxLines: 3, maxLength: 2000, decoration: const InputDecoration(labelText: 'Your reply')),
              if (_error != null) ZxErrorText(_error!),
              ZxButton(label: _busy ? 'Sending…' : 'Send reply', onPressed: _busy ? null : _send),
            ] else
              const Text('This request is closed. Open a new one if you still need help.'),
          ]),
        ),
      );
}

// ═════════════════════════ branches and appointments ═════════════════════════
class BranchesPage extends ConsumerStatefulWidget {
  const BranchesPage({super.key});
  @override
  ConsumerState<BranchesPage> createState() => _BranchesPageState();
}

class _BranchesPageState extends ConsumerState<BranchesPage> {
  final _city = TextEditingController();
  String _applied = '';
  String? _type;

  @override
  void dispose() {
    _city.dispose();
    super.dispose();
  }

  Future<void> _book(Branch b) async {
    final purpose = TextEditingController();
    DateTime? when;
    String? err;
    final done = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text('Visit ${b.name}'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: purpose, decoration: const InputDecoration(labelText: 'What do you need help with?')),
            const SizedBox(height: ZxSpace.sm),
            OutlinedButton(
              onPressed: () async {
                final now = DateTime.now();
                final d = await showDatePicker(context: ctx, initialDate: now.add(const Duration(days: 2)), firstDate: now.add(const Duration(days: 1)), lastDate: now.add(const Duration(days: 60)));
                if (d != null) set(() => when = DateTime(d.year, d.month, d.day, 10));
              },
              child: Text(when == null ? 'Choose a day' : '${_date(when!)} (about 10:00)'),
            ),
            if (err != null) ZxErrorText(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                if (purpose.text.trim().length < 3 || when == null) return set(() => err = 'Add a reason and choose a day.');
                try {
                  await ref.read(supportRepositoryProvider).bookAppointment(branchId: b.id, purpose: purpose.text.trim(), preferredAt: when!);
                  if (ctx.mounted) Navigator.pop(ctx, true);
                } catch (e) {
                  set(() => err = errorText(e));
                }
              },
              child: const Text('Request visit'),
            ),
          ],
        ),
      ),
    );
    purpose.dispose();
    if (done == true && mounted) {
      ref.invalidate(appointmentsProvider);
      _toast(context, 'Requested. The branch will confirm the time.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final branches = ref.watch(branchFinderProvider((city: _applied, type: _type)));
    return ServicePage(
      title: 'Branches and ATMs',
      actions: [IconButton(tooltip: 'My appointments', icon: const Icon(Icons.event_outlined), onPressed: () => context.push('/support/appointments'))],
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(ZxSpace.md),
          child: Column(children: [
            TextField(controller: _city, textInputAction: TextInputAction.search, decoration: const InputDecoration(labelText: 'City', prefixIcon: Icon(Icons.search)), onSubmitted: (v) => setState(() => _applied = v)),
            const SizedBox(height: ZxSpace.sm),
            Wrap(spacing: ZxSpace.sm, children: [for (final (label, value) in const [('All', null), ('Branches', 'BRANCH'), ('ATMs', 'ATM')]) ChoiceChip(label: Text(label), selected: _type == value, onSelected: (_) => setState(() => _type = value))]),
          ]),
        ),
        Expanded(
          child: AsyncView<List<Branch>>(
            value: branches,
            onRetry: () => ref.invalidate(branchFinderProvider),
            builder: (items) => items.isEmpty
                ? const Center(child: Text('No locations found.'))
                : ListView(padding: const EdgeInsets.symmetric(horizontal: ZxSpace.md), children: [
                    for (final b in items)
                      Card(
                        child: ListTile(
                          leading: Icon(b.type == 'ATM' ? Icons.atm : Icons.account_balance),
                          title: Text(b.name),
                          subtitle: Text('${b.address}, ${b.city}${b.hours != null ? '\n${b.hours}' : ''}${b.phone != null ? '\n${b.phone}' : ''}'),
                          isThreeLine: b.hours != null || b.phone != null,
                          trailing: b.type == 'BRANCH' ? TextButton(onPressed: () => _book(b), child: const Text('Book')) : null,
                        ),
                      ),
                  ]),
          ),
        ),
      ]),
    );
  }
}

class AppointmentsPage extends ConsumerWidget {
  const AppointmentsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => ServicePage(
        title: 'My appointments',
        body: AsyncView<List<Appointment>>(
          value: ref.watch(appointmentsProvider),
          onRetry: () => ref.invalidate(appointmentsProvider),
          builder: (items) => items.isEmpty
              ? const Center(child: Text('No appointments.'))
              : ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
                  for (final a in items)
                    Card(
                      child: ListTile(
                        title: Text('${a.branch} · ${a.status.toLowerCase()}'),
                        subtitle: Text('${a.purpose}\n${a.confirmedFor != null ? 'Confirmed for ${_date(a.confirmedFor!)}' : 'Requested for ${_date(a.preferredAt)}'}'),
                        isThreeLine: true,
                        trailing: (a.status == 'REQUESTED' || a.status == 'CONFIRMED')
                            ? TextButton(
                                onPressed: () async {
                                  try {
                                    await ref.read(supportRepositoryProvider).cancelAppointment(a.id);
                                    ref.invalidate(appointmentsProvider);
                                  } catch (e) {
                                    if (context.mounted) _toast(context, errorText(e));
                                  }
                                },
                                child: const Text('Cancel'),
                              )
                            : null,
                      ),
                    ),
                ]),
        ),
      );
}
