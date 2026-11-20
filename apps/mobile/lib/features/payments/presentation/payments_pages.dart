import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../../core/utils/no_retry.dart';
import '../../accounts/data/accounts_repository.dart';
import '../../authentication/data/auth_repository.dart';
import '../../authentication/presentation/auth_pages.dart';
import '../data/payments_repository.dart';
import '../../profile/profile_repository.dart' show prefsProvider;
import '../../../core/design_system/bottom_nav.dart';
import 'payment_flow.dart';

/// The customer's chosen default account when it is usable, otherwise the first one.
String preferredSource(WidgetRef ref, List<Account> usable) {
  final d = ref.watch(prefsProvider).asData?.value.defaultAccountId;
  return usable.any((a) => a.id == d) ? d! : usable.first.id;
}

String _err(Object e) => e is ApiFailure ? e.message : 'Something went wrong. Please try again.';

/// Navigation arguments for the transfer form.
class TransferArgs {
  const TransferArgs({this.beneficiaryId, this.qrPayload});
  final String? beneficiaryId;
  final String? qrPayload;
}

// ───────────────────────── hub ─────────────────────────
class PaymentsHubPage extends StatelessWidget {
  const PaymentsHubPage({super.key});
  @override
  Widget build(BuildContext context) {
    Widget tile(IconData i, String t, String sub, String route) => ListTile(leading: Icon(i), title: Text(t), subtitle: Text(sub), trailing: const Icon(Icons.chevron_right), onTap: () => context.push(route));
    return Scaffold(
      bottomNavigationBar: const ZxBottomNav(index: 1),
      appBar: AppBar(title: const Text('Payments')),
      body: ZxBackdrop(child: SafeArea(child: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        GlassCard(blur: false, padding: EdgeInsets.zero, child: Column(children: [
          tile(Icons.swap_horiz, 'Transfer money', 'Own accounts, Zentrix customers, other banks', '/payments/transfer'),
          tile(Icons.receipt_long_outlined, 'Pay bills', 'Electricity, water, telephone and more', '/payments/bills'),
          tile(Icons.qr_code_scanner, 'Scan to pay', 'Pay a Zentrix QR code', '/payments/scan'),
          tile(Icons.qr_code_2, 'My QR', 'Let others pay you', '/payments/my-qr'),
          tile(Icons.people_outline, 'Recipients', 'Saved people and accounts', '/payments/beneficiaries'),
          tile(Icons.event_repeat, 'Scheduled & repeating', 'Upcoming and standing payments', '/payments/scheduled'),
        ])),
      ]))),
    );
  }
}

// ───────────────────────── transfer form ─────────────────────────
enum _Mode { own, saved, zentrix, other }

class TransferPage extends ConsumerStatefulWidget {
  const TransferPage({super.key, this.args = const TransferArgs()});
  final TransferArgs args;
  @override
  ConsumerState<TransferPage> createState() => _TransferPageState();
}

class _TransferPageState extends ConsumerState<TransferPage> {
  final _form = GlobalKey<FormState>();
  _Mode _mode = _Mode.zentrix;
  String? _source, _own, _saved, _bank;
  final _number = TextEditingController(), _holder = TextEditingController(), _amount = TextEditingController(), _note = TextEditingController();
  DateTime? _date;
  String? _repeat;
  String? _problem;

  @override
  void initState() {
    super.initState();
    if (widget.args.beneficiaryId != null) { _mode = _Mode.saved; _saved = widget.args.beneficiaryId; }
  }

  @override
  void dispose() { for (final c in [_number, _holder, _amount, _note]) { c.dispose(); } super.dispose(); }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final d = await showDatePicker(context: context, initialDate: now.add(const Duration(days: 1)), firstDate: now.add(const Duration(days: 1)), lastDate: now.add(const Duration(days: 365)));
    if (d != null) setState(() => _date = DateTime(d.year, d.month, d.day, 9));
  }

  void _review() {
    if (!_form.currentState!.validate()) return;
    final minor = parseMajorToMinor(_amount.text)!;
    Map<String, dynamic>? dest;
    if (widget.args.qrPayload != null) {
      dest = {'type': 'QR', 'payload': widget.args.qrPayload};
    } else {
      dest = switch (_mode) {
        _Mode.own => {'type': 'OWN', 'accountId': _own},
        _Mode.saved => {'type': 'BENEFICIARY', 'beneficiaryId': _saved},
        _Mode.zentrix => {'type': 'ZENTRIX', 'accountNumber': _number.text.trim()},
        _Mode.other => {'type': 'INTERBANK', 'bankCode': _bank, 'accountNumber': _number.text.trim(), 'holderName': _holder.text.trim()},
      };
    }
    if (_repeat != null && _date == null) { setState(() => _problem = 'Choose a start date for a repeating payment.'); return; }
    setState(() => _problem = null);
    context.push('/payments/review', extra: DraftRequest(sourceAccountId: _source!, destination: dest, amountMinor: minor, note: _note.text.trim(), scheduledFor: _date, frequency: _repeat));
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider);
    final qr = widget.args.qrPayload != null;
    return Scaffold(
      appBar: AppBar(title: Text(qr ? 'Pay with QR' : 'Transfer money')),
      body: ZxBackdrop(
        child: SafeArea(
          child: accounts.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(accountListProvider), child: const Text('Retry'))])),
            data: (list) {
              final active = list.items.where((a) => a.status == 'ACTIVE').toList();
              if (active.isEmpty) return const Center(child: Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('You need an active account to send money.', textAlign: TextAlign.center)));
              _source ??= preferredSource(ref, active);
              return SingleChildScrollView(
                padding: const EdgeInsets.all(ZxSpace.md),
                child: Form(
                  key: _form,
                  child: GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    DropdownButtonFormField<String>(
                      initialValue: _source,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'From'),
                      items: [for (final a in active) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))],
                      onChanged: (v) => setState(() { _source = v; if (_own == v) _own = null; }),
                    ),
                    const SizedBox(height: ZxSpace.md),
                    if (qr)
                      const Text('Paying a scanned Zentrix QR code.')
                    else ...[
                      Wrap(spacing: ZxSpace.sm, children: [
                        for (final (m, label) in [(_Mode.zentrix, 'Zentrix account'), (_Mode.saved, 'Saved'), (_Mode.own, 'My accounts'), (_Mode.other, 'Other bank')])
                          ChoiceChip(label: Text(label), selected: _mode == m, onSelected: (_) => setState(() => _mode = m)),
                      ]),
                      const SizedBox(height: ZxSpace.md),
                      ..._recipientFields(active),
                    ],
                    const SizedBox(height: ZxSpace.md),
                    TextFormField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (LKR)'), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount like 2500.00' : null),
                    const SizedBox(height: ZxSpace.md),
                    TextFormField(controller: _note, maxLength: 60, decoration: const InputDecoration(labelText: 'Note (optional)')),
                    Row(children: [
                      Expanded(child: OutlinedButton.icon(onPressed: _pickDate, icon: const Icon(Icons.event), label: Text(_date == null ? 'Send now' : 'On ${fmtDate(_date!)}'))),
                      if (_date != null) IconButton(tooltip: 'Send now instead', icon: const Icon(Icons.close), onPressed: () => setState(() { _date = null; _repeat = null; })),
                    ]),
                    if (_date != null) DropdownButtonFormField<String?>(
                      initialValue: _repeat,
                      decoration: const InputDecoration(labelText: 'Repeat'),
                      items: const [DropdownMenuItem(value: null, child: Text('Does not repeat')), DropdownMenuItem(value: 'WEEKLY', child: Text('Every week')), DropdownMenuItem(value: 'MONTHLY', child: Text('Every month'))],
                      onChanged: (v) => setState(() => _repeat = v),
                    ),
                    const SizedBox(height: ZxSpace.md),
                    ZxErrorText(_problem),
                    ZxButton(label: 'Review', onPressed: _review),
                  ])),
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  List<Widget> _recipientFields(List<Account> active) {
    switch (_mode) {
      case _Mode.own:
        final others = active.where((a) => a.id != _source).toList();
        if (others.isEmpty) return [const Text('You have no other account to move money to.')];
        return [DropdownButtonFormField<String>(initialValue: _own, isExpanded: true, decoration: const InputDecoration(labelText: 'To'), validator: (v) => v == null ? 'Choose an account' : null, items: [for (final a in others) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _own = v))];
      case _Mode.saved:
        final b = ref.watch(beneficiariesProvider);
        return [
          b.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Column(children: [ZxErrorText(_err(e)), TextButton(onPressed: () => ref.invalidate(beneficiariesProvider), child: const Text('Retry'))]),
            data: (items) => items.isEmpty
                ? const Text('No saved recipients yet. Add one under Recipients.')
                : DropdownButtonFormField<String>(initialValue: items.any((x) => x.id == _saved) ? _saved : null, isExpanded: true, decoration: const InputDecoration(labelText: 'To'), validator: (v) => v == null ? 'Choose a recipient' : null, items: [for (final x in items) DropdownMenuItem(value: x.id, child: Text('${x.title} · ${x.bankName}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _saved = v)),
          ),
        ];
      case _Mode.zentrix:
        return [TextFormField(controller: _number, keyboardType: TextInputType.number, maxLength: 11, decoration: const InputDecoration(labelText: 'Zentrix account number', counterText: ''), validator: (v) => RegExp(r'^\d{11}$').hasMatch(v ?? '') ? null : 'Enter the 11-digit account number')];
      case _Mode.other:
        final banks = ref.watch(catalogProvider).asData?.value.banks ?? const <Bank>[];
        return [
          DropdownButtonFormField<String>(initialValue: _bank, isExpanded: true, decoration: const InputDecoration(labelText: 'Bank'), validator: (v) => v == null ? 'Choose a bank' : null, items: [for (final b in banks) DropdownMenuItem(value: b.code, child: Text(b.name))], onChanged: (v) => setState(() => _bank = v)),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _number, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Account number'), validator: (v) => RegExp(r'^\d{8,16}$').hasMatch(v ?? '') ? null : '8-16 digits'),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _holder, decoration: const InputDecoration(labelText: 'Account holder name'), validator: (v) => (v ?? '').trim().length < 2 ? 'Required' : null),
          const SizedBox(height: ZxSpace.sm),
          const Text('Other-bank transfers carry a fee set by the bank, shown before you authorize.'),
        ];
    }
  }
}

// ───────────────────────── bills ─────────────────────────
class BillsPage extends ConsumerStatefulWidget {
  const BillsPage({super.key});
  @override
  ConsumerState<BillsPage> createState() => _BillsPageState();
}

class _BillsPageState extends ConsumerState<BillsPage> {
  final _form = GlobalKey<FormState>();
  String? _category, _biller, _source;
  final _ref = TextEditingController(), _amount = TextEditingController();
  @override
  void dispose() { _ref.dispose(); _amount.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final cat = ref.watch(catalogProvider);
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status == 'ACTIVE').toList() ?? const <Account>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Pay bills')),
      body: ZxBackdrop(child: SafeArea(child: cat.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(catalogProvider), child: const Text('Retry'))])),
        data: (c) {
          final cats = c.billers.map((b) => b.category).toSet().toList();
          final billers = c.billers.where((b) => b.category == _category).toList();
          if (accounts.isNotEmpty) _source ??= preferredSource(ref, accounts);
          return SingleChildScrollView(padding: const EdgeInsets.all(ZxSpace.md), child: Form(key: _form, child: GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<String>(initialValue: _category, isExpanded: true, decoration: const InputDecoration(labelText: 'Category'), validator: (v) => v == null ? 'Choose a category' : null, items: [for (final x in cats) DropdownMenuItem(value: x, child: Text(x))], onChanged: (v) => setState(() { _category = v; _biller = null; })),
            const SizedBox(height: ZxSpace.md),
            DropdownButtonFormField<String>(initialValue: _biller, isExpanded: true, decoration: const InputDecoration(labelText: 'Biller'), validator: (v) => v == null ? 'Choose a biller' : null, items: [for (final b in billers) DropdownMenuItem(value: b.code, child: Text(b.name, overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _biller = v)),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _ref, decoration: const InputDecoration(labelText: 'Account / reference number'), validator: (v) => (v ?? '').trim().length < 3 ? 'Enter the bill reference' : null),
            const SizedBox(height: ZxSpace.md),
            TextFormField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (LKR)'), validator: (v) => parseMajorToMinor(v ?? '') == null ? 'Enter an amount like 2500.00' : null),
            const SizedBox(height: ZxSpace.md),
            DropdownButtonFormField<String>(initialValue: _source, isExpanded: true, decoration: const InputDecoration(labelText: 'Pay from'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _source = v)),
            const SizedBox(height: ZxSpace.md),
            ZxButton(label: 'Review', onPressed: _source == null ? null : () {
              if (!_form.currentState!.validate()) return;
              context.push('/payments/review', extra: DraftRequest(sourceAccountId: _source!, destination: {'type': 'BILL', 'billerCode': _biller, 'billRef': _ref.text.trim()}, amountMinor: parseMajorToMinor(_amount.text)!));
            }),
          ]))));
        },
      ))),
    );
  }
}

// ───────────────────────── beneficiaries ─────────────────────────
class BeneficiariesPage extends ConsumerWidget {
  const BeneficiariesPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(beneficiariesProvider);
    final repo = ref.read(paymentsRepositoryProvider);
    Future<void> guarded(Future<void> Function() f) async {
      try { await f(); ref.invalidate(beneficiariesProvider); } on ApiFailure catch (e) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message))); }
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Recipients')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => context.push('/payments/beneficiaries/add'), icon: const Icon(Icons.person_add_alt), label: const Text('Add recipient')),
      body: ZxBackdrop(child: SafeArea(child: items.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(beneficiariesProvider), child: const Text('Retry'))])),
        data: (list) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(beneficiariesProvider),
          child: ListView(padding: const EdgeInsets.fromLTRB(ZxSpace.md, ZxSpace.md, ZxSpace.md, 96), physics: const AlwaysScrollableScrollPhysics(), children: [
            if (list.isEmpty) const Padding(padding: EdgeInsets.all(ZxSpace.lg), child: Text('No saved recipients yet.', textAlign: TextAlign.center)),
            for (final b in list)
              Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, padding: EdgeInsets.zero, child: ListTile(
                onTap: () => context.push('/payments/transfer', extra: TransferArgs(beneficiaryId: b.id)),
                title: Text(b.title, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('${b.holderName} · ${b.bankName} · ${b.accountMasked}'),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(tooltip: b.favorite ? 'Remove favourite' : 'Make favourite', icon: Icon(b.favorite ? Icons.star : Icons.star_border), onPressed: () => guarded(() => repo.setFavorite(b.id, !b.favorite))),
                  IconButton(tooltip: 'Delete recipient', icon: const Icon(Icons.delete_outline), onPressed: () async {
                    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(title: const Text('Remove recipient?'), content: Text('${b.title} will be removed from your saved recipients.'), actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')), TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Remove'))]));
                    if (ok == true) await guarded(() => repo.removeBeneficiary(b.id));
                  }),
                ]),
              ))),
          ]),
        ),
      ))),
    );
  }
}

class AddBeneficiaryPage extends ConsumerStatefulWidget {
  const AddBeneficiaryPage({super.key});
  @override
  ConsumerState<AddBeneficiaryPage> createState() => _AddBeneficiaryPageState();
}

class _AddBeneficiaryPageState extends ConsumerState<AddBeneficiaryPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  String _bank = 'ZENTRIX';
  final _number = TextEditingController(), _holder = TextEditingController(), _nick = TextEditingController();
  @override
  void dispose() { for (final c in [_number, _holder, _nick]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final banks = ref.watch(catalogProvider).asData?.value.banks ?? const <Bank>[];
    final zentrix = _bank == 'ZENTRIX';
    return AuthScaffold(title: 'Add recipient', back: true, children: [
      Form(key: _form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<String>(initialValue: _bank, isExpanded: true, decoration: const InputDecoration(labelText: 'Bank'), items: [const DropdownMenuItem(value: 'ZENTRIX', child: Text('Zentrix Bank')), for (final b in banks) DropdownMenuItem(value: b.code, child: Text(b.name))], onChanged: (v) => setState(() => _bank = v ?? 'ZENTRIX')),
        const SizedBox(height: ZxSpace.md),
        TextFormField(controller: _number, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: 'Account number', errorText: fieldErrors['accountNumber']), validator: (v) => RegExp(zentrix ? r'^\d{11}$' : r'^\d{8,16}$').hasMatch(v ?? '') ? null : (zentrix ? 'Enter the 11-digit number' : '8-16 digits')),
        if (!zentrix) ...[const SizedBox(height: ZxSpace.md), TextFormField(controller: _holder, decoration: InputDecoration(labelText: 'Account holder name', errorText: fieldErrors['holderName']), validator: (v) => (v ?? '').trim().length < 2 ? 'Required' : null)]
        else const Padding(padding: EdgeInsets.only(top: ZxSpace.sm), child: Text('The bank fills in the account holder’s name for you.')),
        const SizedBox(height: ZxSpace.md),
        TextFormField(controller: _nick, maxLength: 40, decoration: const InputDecoration(labelText: 'Nickname (optional)')),
        ZxErrorText(error),
        ZxButton(label: 'Save recipient', loading: busy, onPressed: () {
          if (!_form.currentState!.validate()) return;
          final router = GoRouter.of(context);
          run(() async {
            await ref.read(paymentsRepositoryProvider).addBeneficiary(bankCode: _bank, accountNumber: _number.text.trim(), holderName: zentrix ? null : _holder.text.trim(), nickname: _nick.text.trim());
            ref.invalidate(beneficiariesProvider);
            router.pop();
          });
        }),
      ])),
    ]);
  }
}

// ───────────────────────── QR ─────────────────────────
class MyQrPage extends ConsumerStatefulWidget {
  const MyQrPage({super.key});
  @override
  ConsumerState<MyQrPage> createState() => _MyQrPageState();
}

class _MyQrPageState extends ConsumerState<MyQrPage> {
  String? _account;
  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status != 'CLOSED').toList() ?? const <Account>[];
    if (accounts.isNotEmpty) _account ??= accounts.first.id;
    return Scaffold(
      appBar: AppBar(title: const Text('My QR')),
      body: ZxBackdrop(child: SafeArea(child: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(ZxSpace.md), child: GlassCard(child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (accounts.isEmpty) const Text('You have no accounts yet.') else ...[
          DropdownButtonFormField<String>(initialValue: _account, isExpanded: true, decoration: const InputDecoration(labelText: 'Receive into'), items: [for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.title} · ${a.maskedNumber}', overflow: TextOverflow.ellipsis))], onChanged: (v) => setState(() => _account = v)),
          const SizedBox(height: ZxSpace.md),
          FutureBuilder<String>(
            key: ValueKey(_account),
            future: ref.read(paymentsRepositoryProvider).myQrPayload(_account!),
            builder: (context, s) {
              if (s.hasError) return Text(_err(s.error!));
              if (!s.hasData) return const SizedBox(height: 220, child: Center(child: CircularProgressIndicator()));
              // White tile regardless of theme so the code stays scannable.
              return Container(color: Colors.white, padding: const EdgeInsets.all(12), child: QrImageView(data: s.data!, size: 220, semanticsLabel: 'Your Zentrix payment QR code'));
            },
          ),
          const SizedBox(height: ZxSpace.md),
          const Text('This code contains only your account number. It never contains an amount or balance.', textAlign: TextAlign.center),
        ],
      ]))))),
    ));
  }
}

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});
  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  bool _handled = false;
  String? _message;

  void _onDetect(BarcodeCapture c) {
    if (_handled) return; // the camera repeats a code; handle it once
    final v = c.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
    if (v == null) return;
    if (!RegExp(r'^ZENTRIX1\|\d{11}$').hasMatch(v)) { setState(() => _message = 'That is not a Zentrix payment code.'); return; }
    _handled = true;
    context.pushReplacement('/payments/transfer', extra: TransferArgs(qrPayload: v));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Scan to pay')),
        body: Stack(children: [
          MobileScanner(
            onDetect: _onDetect,
            errorBuilder: (context, error) => Center(child: Padding(padding: const EdgeInsets.all(ZxSpace.lg), child: Text('The camera is not available (${error.errorCode.name}). Allow camera access in Settings to scan codes.', textAlign: TextAlign.center))),
          ),
          if (_message != null) Positioned(left: 16, right: 16, bottom: 32, child: Semantics(liveRegion: true, child: GlassCard(blur: false, child: Text(_message!, textAlign: TextAlign.center)))),
        ]),
      );
}

// ───────────────────────── scheduled ─────────────────────────
class ScheduledPage extends ConsumerWidget {
  const ScheduledPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final one = ref.watch(scheduledProvider);
    final rec = ref.watch(recurringProvider);
    final repo = ref.read(paymentsRepositoryProvider);
    Future<void> guarded(Future<void> Function() f) async {
      try { await f(); ref.invalidate(scheduledProvider); ref.invalidate(recurringProvider); } on ApiFailure catch (e) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message))); }
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Scheduled & repeating')),
      body: ZxBackdrop(child: SafeArea(child: RefreshIndicator(
        onRefresh: () async { ref.invalidate(scheduledProvider); ref.invalidate(recurringProvider); },
        child: ListView(padding: const EdgeInsets.all(ZxSpace.md), physics: const AlwaysScrollableScrollPhysics(), children: [
          Text('Upcoming', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: ZxSpace.sm),
          one.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Column(children: [ZxErrorText(_err(e)), TextButton(onPressed: () => ref.invalidate(scheduledProvider), child: const Text('Retry'))]),
            data: (list) => list.isEmpty ? const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Text('No upcoming payments.')) : Column(children: [
              for (final p in list) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, padding: EdgeInsets.zero, child: ListTile(
                onTap: () => context.push('/receipts/${p.id}'),
                title: Text('${formatMinor(p.amountMinor)} to ${p.recipient.name}', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('On ${p.scheduledFor == null ? '' : fmtDate(p.scheduledFor!)} · ${p.reference}'),
                trailing: TextButton(onPressed: () => guarded(() async { await repo.cancel(p.id); }), child: const Text('Cancel')),
              ))),
            ]),
          ),
          const SizedBox(height: ZxSpace.md),
          Text('Repeating', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: ZxSpace.sm),
          rec.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Column(children: [ZxErrorText(_err(e)), TextButton(onPressed: () => ref.invalidate(recurringProvider), child: const Text('Retry'))]),
            data: (list) => list.isEmpty ? const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Text('No repeating payments.')) : Column(children: [
              for (final r in list) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, padding: EdgeInsets.zero, child: ListTile(
                title: Text('${formatMinor(r.amountMinor)} to ${r.recipient.name}', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('${r.frequency == 'WEEKLY' ? 'Every week' : 'Every month'} · next ${fmtDate(r.nextRunAt)}${r.lastFailure != null ? '\nLast run failed: ${r.lastFailure}' : ''}'),
                isThreeLine: r.lastFailure != null,
                trailing: TextButton(onPressed: () => guarded(() => repo.cancelRecurring(r.id)), child: const Text('Stop')),
              ))),
            ]),
          ),
        ]),
      ))),
    );
  }
}

// ───────────────────────── notifications ─────────────────────────
class NotificationsPage extends ConsumerStatefulWidget {
  const NotificationsPage({super.key});
  @override
  ConsumerState<NotificationsPage> createState() => _NotificationsPageState();
}

const _notificationFilters = [('All', null), ('Payments', 'TRANSACTION'), ('Security', 'SECURITY'), ('Accounts', 'ACCOUNT'), ('Cards', 'CARD'), ('Loans', 'LOAN'), ('Deposits', 'DEPOSIT'), ('Budgets', 'BUDGET')];

class _NotificationsPageState extends ConsumerState<NotificationsPage> {
  String? _category;

  @override
  Widget build(BuildContext context) {
    final feed = ref.watch(notificationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Notifications'), actions: [
        TextButton(onPressed: () async { await ref.read(paymentsRepositoryProvider).markAllRead(); ref.invalidate(notificationsProvider); }, child: const Text('Mark all read')),
      ]),
      body: ZxBackdrop(child: SafeArea(child: feed.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(_err(e)), TextButton(onPressed: () => ref.invalidate(notificationsProvider), child: const Text('Retry'))])),
        data: (f) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(notificationsProvider),
          child: ListView(padding: const EdgeInsets.all(ZxSpace.md), physics: const AlwaysScrollableScrollPhysics(), children: [
            Wrap(spacing: ZxSpace.sm, runSpacing: ZxSpace.xs, children: [for (final (label, value) in _notificationFilters) ChoiceChip(label: Text(label), selected: _category == value, onSelected: (_) => setState(() => _category = value))]),
            const SizedBox(height: ZxSpace.sm),
            if (f.items.where((n) => _category == null || n.category == _category).isEmpty) Padding(padding: const EdgeInsets.all(ZxSpace.lg), child: Text(_category == null ? 'No notifications yet.' : 'Nothing in this category.', textAlign: TextAlign.center)),
            for (final n in f.items.where((n) => _category == null || n.category == _category)) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, padding: EdgeInsets.zero, child: ListTile(
              leading: Icon(n.read ? Icons.notifications_none : Icons.notifications_active, color: n.read ? null : context.zx.primary),
              title: Text(n.title, style: TextStyle(fontWeight: n.read ? FontWeight.w500 : FontWeight.w800)),
              subtitle: Text('${n.body}\n${fmtDateTime(n.createdAt)}'),
              isThreeLine: true,
              onTap: n.read ? null : () async { await ref.read(paymentsRepositoryProvider).markRead(n.id); ref.invalidate(notificationsProvider); ref.invalidate(unreadCountProvider); },
            ))),
          ]),
        ),
      ))),
    );
  }
}

/// Unread-count provider for the home badge.
final unreadCountProvider = FutureProvider.autoDispose<int>((ref) async => (await ref.watch(paymentsRepositoryProvider).notifications()).unread, retry: noRetry);
