import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../../accounts/data/accounts_repository.dart';
import '../../authentication/data/auth_repository.dart';
import '../../authentication/presentation/auth_controller.dart';
import '../data/payments_repository.dart';

String two(int n) => n.toString().padLeft(2, '0');
String fmtDate(DateTime t) {
  final l = t.toLocal();
  return '${l.year}-${two(l.month)}-${two(l.day)}';
}
String fmtDateTime(DateTime t) {
  final l = t.toLocal();
  return '${fmtDate(l)} ${two(l.hour)}:${two(l.minute)}';
}

enum _Phase { creating, review, authorizing, done, recurringDone, unknownCreate, unknownAuth, error }

/// review -> PIN authorisation -> processing -> receipt.
/// Every number shown comes from the bank. A dropped connection NEVER becomes "failed": it becomes an unknown outcome
/// that is reconciled with the bank before the customer is told anything.
class PaymentReviewPage extends ConsumerStatefulWidget {
  const PaymentReviewPage({super.key, required this.draft});
  final DraftRequest draft;
  @override
  ConsumerState<PaymentReviewPage> createState() => _PaymentReviewPageState();
}

class _PaymentReviewPageState extends ConsumerState<PaymentReviewPage> {
  _Phase _phase = _Phase.creating;
  Payment? _payment;
  String? _error;

  bool get _recurring => widget.draft.frequency != null;

  @override
  void initState() {
    super.initState();
    if (_recurring) {
      _phase = _Phase.review;
    } else {
      Future.microtask(_create);
    }
  }

  Future<void> _create() async {
    setState(() { _phase = _Phase.creating; _error = null; });
    try {
      final p = await ref.read(paymentsRepositoryProvider).createDraft(widget.draft); // same key on every retry
      if (!mounted) return;
      setState(() { _payment = p; _phase = _Phase.review; });
    } on ApiFailure catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _phase = e.network ? _Phase.unknownCreate : _Phase.error; });
    }
  }

  Future<void> _authorize() async {
    final pin = await showModalBottomSheet<String>(context: context, isScrollControlled: true, builder: (_) => const _PinSheet());
    if (pin == null || !mounted) return;
    setState(() { _phase = _Phase.authorizing; _error = null; });
    final repo = ref.read(paymentsRepositoryProvider);
    try {
      if (_recurring) {
        await repo.createRecurring(widget.draft, pin);
        if (mounted) setState(() => _phase = _Phase.recurringDone);
      } else {
        final p = await repo.authorize(_payment!.id, pin);
        ref.invalidate(accountListProvider);
        if (mounted) setState(() { _payment = p; _phase = _Phase.done; });
      }
    } on ApiFailure catch (e) {
      if (!mounted) return;
      if (e.network) {
        // The request may or may not have reached the bank. Do NOT call this a failure.
        setState(() { _error = e.message; _phase = _recurring ? _Phase.error : _Phase.unknownAuth; });
      } else if (e.code == 'unauthenticated' || e.code == 'session_expired' || e.message.startsWith('Too many attempts')) {
        await ref.read(authControllerProvider.notifier).logout();
      } else {
        setState(() { _error = e.message; _phase = e.code == 'payment_expired' ? _Phase.error : _Phase.review; });
      }
    }
  }

  Future<void> _checkStatus() async {
    setState(() { _error = null; });
    try {
      final p = await ref.read(paymentsRepositoryProvider).get(_payment!.id);
      ref.invalidate(accountListProvider);
      if (!mounted) return;
      setState(() {
        _payment = p;
        _phase = p.status == 'AWAITING_AUTHORIZATION' ? _Phase.review : _Phase.done;
        if (p.status == 'AWAITING_AUTHORIZATION') _error = 'The bank has not received your authorisation, so nothing was sent. You can try again.';
      });
    } on ApiFailure catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountListProvider).asData?.value.items ?? const <Account>[];
    final from = accounts.where((a) => a.id == widget.draft.sourceAccountId).firstOrNull;
    return PopScope(
      canPop: _phase != _Phase.authorizing,
      child: Scaffold(
        appBar: AppBar(title: Text(switch (_phase) { _Phase.done => 'Receipt', _Phase.recurringDone => 'Scheduled', _ => 'Review payment' }), automaticallyImplyLeading: _phase != _Phase.authorizing && _phase != _Phase.done && _phase != _Phase.recurringDone),
        body: ZxBackdrop(
          child: SafeArea(
            child: AnimatedSwitcher(
              duration: ZxMotion.scaled(context, ZxMotion.page),
              child: SingleChildScrollView(key: ValueKey(_phase), padding: const EdgeInsets.all(ZxSpace.md), child: _body(context, from)),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, Account? from) {
    switch (_phase) {
      case _Phase.creating:
        return const Padding(padding: EdgeInsets.all(ZxSpace.xl), child: Center(child: CircularProgressIndicator(semanticsLabel: 'Preparing your payment')));
      case _Phase.authorizing:
        return Semantics(liveRegion: true, child: const Padding(padding: EdgeInsets.all(ZxSpace.xl), child: Column(children: [CircularProgressIndicator(), SizedBox(height: ZxSpace.md), Text('Processing your payment…\nPlease keep the app open.', textAlign: TextAlign.center)])));
      case _Phase.unknownCreate:
        return _Notice(icon: Icons.cloud_off, title: 'Cannot reach the bank', body: 'Nothing has been sent. Check your connection and try again.', actions: [ZxButton(label: 'Try again', onPressed: _create)]);
      case _Phase.unknownAuth:
        return _Notice(
          icon: Icons.hourglass_top,
          title: 'We could not confirm this payment',
          body: 'The connection dropped while sending. The payment may or may not have gone through — please check its status before trying again. Do not pay twice.',
          error: _error,
          actions: [ZxButton(label: 'Check status', onPressed: _checkStatus)],
        );
      case _Phase.error:
        return _Notice(icon: Icons.error_outline, title: 'Payment not sent', body: _error ?? 'Something went wrong.', actions: [ZxButton(label: 'Back', onPressed: () => context.pop())]);
      case _Phase.recurringDone:
        return _Notice(icon: Icons.event_repeat, title: 'Repeating payment set up', body: '${formatMinor(widget.draft.amountMinor)} will be sent ${widget.draft.frequency == 'WEEKLY' ? 'every week' : 'every month'} starting ${fmtDate(widget.draft.scheduledFor!)}. Each run checks your balance and limits on the day.', actions: [ZxButton(label: 'Done', onPressed: () => context.go('/'))]);
      case _Phase.done:
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ReceiptCard(_payment!, fromLabel: from?.title),
          const SizedBox(height: ZxSpace.md),
          ZxButton(label: 'Done', onPressed: () => context.go('/')),
        ]);
      case _Phase.review:
        final p = _payment;
        final d = widget.draft;
        final amount = p?.amountMinor ?? d.amountMinor;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          GlassCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('You are sending', style: TextStyle(color: context.zx.textMuted)),
            Text(formatMinor(amount), style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: ZxSpace.md),
            if (p != null) ...[
              _Row('To', '${p.recipient.name}\n${p.recipient.bank} · ${p.recipient.accountMasked}'),
              _Row('Fee', p.feeMinor == 0 ? 'No fee' : formatMinor(p.feeMinor)),
              _Row('Total', formatMinor(p.totalMinor), bold: true),
            ] else
              _Row('Fee', 'Calculated by the bank on each payment'),
            if (from != null) _Row('From', '${from.title} · ${from.maskedNumber}'),
            if (d.note?.isNotEmpty == true) _Row('Note', d.note!),
            if (d.scheduledFor != null) _Row(_recurring ? 'Starts' : 'Scheduled for', fmtDate(d.scheduledFor!)),
            if (_recurring) _Row('Repeats', d.frequency == 'WEEKLY' ? 'Every week' : 'Every month'),
          ])),
          const SizedBox(height: ZxSpace.md),
          ZxErrorText(_error),
          ZxButton(label: _recurring ? 'Authorize repeating payment' : (d.scheduledFor != null ? 'Authorize scheduled payment' : 'Authorize payment'), onPressed: _authorize),
          TextButton(onPressed: () => context.pop(), child: const Text('Cancel')),
        ]);
    }
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {this.bold = false});
  final String label;
  final String value;
  final bool bold;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 96, child: Text(label, style: TextStyle(color: context.zx.textMuted))),
          Expanded(child: Text(value, textAlign: TextAlign.end, style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w600))),
        ]),
      );
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.title, required this.body, required this.actions, this.error});
  final IconData icon;
  final String title;
  final String body;
  final String? error;
  final List<Widget> actions;
  @override
  Widget build(BuildContext context) => GlassCard(
        child: Column(children: [
          Icon(icon, size: 56, color: context.zx.primary),
          const SizedBox(height: ZxSpace.md),
          Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: ZxSpace.sm),
          Text(body, textAlign: TextAlign.center),
          const SizedBox(height: ZxSpace.md),
          ZxErrorText(error),
          ...actions,
        ]),
      );
}

/// Authoritative receipt: built only from what the bank returned.
class ReceiptCard extends StatelessWidget {
  const ReceiptCard(this.p, {super.key, this.fromLabel});
  final Payment p;
  final String? fromLabel;

  @override
  Widget build(BuildContext context) {
    final z = context.zx;
    final (IconData icon, Color color, String title, String sub) = switch (p.status) {
      'POSTED' => (Icons.check_circle, z.success, 'Payment successful', 'Completed ${p.postedAt == null ? '' : fmtDateTime(p.postedAt!)}'),
      'AUTHORIZED' when p.scheduledFor != null => (Icons.event_available, z.primary, 'Payment scheduled', 'Will be sent on ${fmtDate(p.scheduledFor!)}. Your balance and limits are checked that day.'),
      'FAILED' => (Icons.cancel, z.error, 'Payment failed', '${p.failureMessage ?? 'The payment could not be completed.'} No money was taken.'),
      'CANCELLED' => (Icons.block, z.textMuted, 'Payment cancelled', 'No money was taken.'),
      _ => (Icons.hourglass_top, z.warning, 'Payment pending', 'The bank is still processing this payment.'),
    };
    return GlassCard(
      child: Column(children: [
        TweenAnimationBuilder<double>(
          tween: Tween(begin: 0.6, end: 1),
          duration: ZxMotion.scaled(context, ZxMotion.large),
          curve: Curves.elasticOut,
          builder: (_, v, child) => Transform.scale(scale: v, child: child),
          child: Icon(icon, size: 72, color: color, semanticLabel: title),
        ),
        const SizedBox(height: ZxSpace.sm),
        Text(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        Text(sub, textAlign: TextAlign.center, style: TextStyle(color: z.textMuted)),
        const SizedBox(height: ZxSpace.md),
        _Row('Amount', formatMinor(p.amountMinor), bold: true),
        if (p.feeMinor > 0) _Row('Fee', formatMinor(p.feeMinor)),
        if (p.feeMinor > 0) _Row('Total', formatMinor(p.totalMinor), bold: true),
        _Row('To', '${p.recipient.name}\n${p.recipient.bank} · ${p.recipient.accountMasked}'),
        if (fromLabel != null) _Row('From', fromLabel!),
        if (p.note?.isNotEmpty == true) _Row('Note', p.note!),
        _Row('Reference', p.reference),
        const SizedBox(height: ZxSpace.sm),
        TextButton.icon(onPressed: () { Clipboard.setData(ClipboardData(text: p.reference)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Reference copied'))); }, icon: const Icon(Icons.copy, size: 18), label: const Text('Copy reference')),
      ]),
    );
  }
}

/// Opens a past payment's receipt (e.g. from the scheduled list).
class ReceiptPage extends ConsumerWidget {
  const ReceiptPage({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final f = ref.watch(_paymentProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Receipt')),
      body: ZxBackdrop(child: SafeArea(child: f.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text(e is ApiFailure ? e.message : 'Something went wrong.'), TextButton(onPressed: () => ref.invalidate(_paymentProvider(id)), child: const Text('Retry'))])),
        data: (p) => SingleChildScrollView(padding: const EdgeInsets.all(ZxSpace.md), child: ReceiptCard(p)),
      ))),
    );
  }
}

final _paymentProvider = FutureProvider.autoDispose.family<Payment, String>((ref, id) => ref.watch(paymentsRepositoryProvider).get(id), retry: (_, _) => null);

class _PinSheet extends StatefulWidget {
  const _PinSheet();
  @override
  State<_PinSheet> createState() => _PinSheetState();
}

class _PinSheetState extends State<_PinSheet> {
  final _c = TextEditingController();
  @override
  void dispose() { _c.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(ZxSpace.lg, ZxSpace.lg, ZxSpace.lg, MediaQuery.of(context).viewInsets.bottom + ZxSpace.lg),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Authorize with your PIN', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _c, autofocus: true, obscureText: true, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'App PIN', counterText: ''), onSubmitted: (_) => _done()),
        const SizedBox(height: ZxSpace.sm),
        ZxButton(label: 'Confirm', onPressed: _done),
      ]),
    );
  }

  void _done() { if (RegExp(r'^(\d{4}|\d{6})$').hasMatch(_c.text)) Navigator.of(context).pop(_c.text); }
}
