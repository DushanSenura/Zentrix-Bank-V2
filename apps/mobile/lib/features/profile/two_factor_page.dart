import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/design_system/async_view.dart';
import '../../core/design_system/tokens.dart';
import '../../core/design_system/widgets.dart';
import '../payments/presentation/payment_flow.dart' show askPin;
import 'profile_repository.dart';

/// Optional two-step sign-in with an authenticator app. Turning it on or off needs the app PIN and a working code.
class TwoFactorPage extends ConsumerStatefulWidget {
  const TwoFactorPage({super.key});
  @override
  ConsumerState<TwoFactorPage> createState() => _TwoFactorPageState();
}

class _TwoFactorPageState extends ConsumerState<TwoFactorPage> {
  bool _busy = false;
  String? _error;
  ({String secret, String uri})? _enrolment;
  List<String>? _codes; // shown once, right after turning on (or regenerating)
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() f) async {
    setState(() { _busy = true; _error = null; });
    try {
      await f();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _askCode(String title) => showDialog<String>(context: context, builder: (_) => _CodeDialog(title: title));

  Future<void> _start() async {
    final pin = await askPin(context);
    if (pin == null || !mounted) return;
    await _run(() async {
      final e = await ref.read(profileRepositoryProvider).twoFactorSetup(pin);
      if (mounted) setState(() { _enrolment = e; _code.clear(); });
    });
  }

  Future<void> _confirm() async {
    if (!RegExp(r'^\d{6}$').hasMatch(_code.text.trim())) return setState(() => _error = 'Enter the 6-digit code from your authenticator app.');
    await _run(() async {
      final codes = await ref.read(profileRepositoryProvider).twoFactorEnable(_code.text.trim());
      ref.invalidate(twoFactorProvider);
      if (mounted) setState(() { _codes = codes; _enrolment = null; });
    });
  }

  Future<void> _disable() async {
    final pin = await askPin(context);
    if (pin == null || !mounted) return;
    final code = await _askCode('Turn off two-step sign-in');
    if (code == null || code.isEmpty || !mounted) return;
    await _run(() async {
      await ref.read(profileRepositoryProvider).twoFactorDisable(pin, code);
      ref.invalidate(twoFactorProvider);
      if (mounted) { setState(() => _codes = null); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Two-step sign-in is off.'))); }
    });
  }

  Future<void> _regenerate() async {
    final pin = await askPin(context);
    if (pin == null || !mounted) return;
    final code = await _askCode('New recovery codes');
    if (code == null || code.isEmpty || !mounted) return;
    await _run(() async {
      final codes = await ref.read(profileRepositoryProvider).twoFactorNewRecoveryCodes(pin, code);
      ref.invalidate(twoFactorProvider);
      if (mounted) setState(() => _codes = codes);
    });
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Two-step sign-in',
        body: AsyncView<TwoFactorStatus>(
          value: ref.watch(twoFactorProvider),
          onRetry: () => ref.invalidate(twoFactorProvider),
          builder: (s) => ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            if (_codes != null) _RecoveryCodes(_codes!, onDone: () => setState(() => _codes = null)),
            if (_codes == null && _enrolment != null) _Enrol(_enrolment!, _code, _busy, _confirm),
            if (_codes == null && _enrolment == null)
              GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [Icon(s.enabled ? Icons.verified_user : Icons.shield_outlined, color: s.enabled ? context.zx.success : null), const SizedBox(width: ZxSpace.sm), Expanded(child: Text(s.enabled ? 'Two-step sign-in is on' : 'Two-step sign-in is off', style: Theme.of(context).textTheme.titleMedium))]),
                const SizedBox(height: ZxSpace.sm),
                Text(s.enabled ? 'You enter a code from your authenticator app each time you sign in. You have ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft == 1 ? '' : 's'} left.' : 'Add a second step to signing in: a 6-digit code from an authenticator app on your phone. Even if someone learns your password they cannot sign in without it.'),
                const SizedBox(height: ZxSpace.md),
                if (!s.enabled) ZxButton(label: _busy ? 'Starting…' : 'Turn on', onPressed: _busy ? null : _start),
                if (s.enabled) ...[
                  OutlinedButton(onPressed: _busy ? null : _regenerate, child: const Text('Get new recovery codes')),
                  const SizedBox(height: ZxSpace.sm),
                  OutlinedButton(style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error), onPressed: _busy ? null : _disable, child: const Text('Turn off')),
                ],
              ])),
            if (_error != null) ZxErrorText(_error!),
          ]),
        ),
      );
}

class _Enrol extends StatelessWidget {
  const _Enrol(this.e, this.code, this.busy, this.onConfirm);
  final ({String secret, String uri}) e;
  final TextEditingController code;
  final bool busy;
  final VoidCallback onConfirm;
  @override
  Widget build(BuildContext context) => GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('1. Add this account to your authenticator app', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: ZxSpace.sm),
        Center(child: Semantics(label: 'QR code for your authenticator app', child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: e.uri, size: 180)))),
        const SizedBox(height: ZxSpace.sm),
        const Text('Cannot scan? Enter this key by hand:'),
        SelectableText(e.secret, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700)),
        const SizedBox(height: ZxSpace.md),
        Text('2. Enter the 6-digit code it shows', style: Theme.of(context).textTheme.titleSmall),
        TextField(controller: code, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'Authenticator code')),
        ZxButton(label: busy ? 'Checking…' : 'Confirm and turn on', onPressed: busy ? null : onConfirm),
      ]));
}

class _RecoveryCodes extends StatelessWidget {
  const _RecoveryCodes(this.codes, {required this.onDone});
  final List<String> codes;
  final VoidCallback onDone;
  @override
  Widget build(BuildContext context) => GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Save your recovery codes', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: ZxSpace.xs),
        const Text('If you lose your phone, each of these signs you in once. They are shown only now: store them somewhere safe, not on this phone.'),
        const SizedBox(height: ZxSpace.sm),
        Wrap(spacing: ZxSpace.md, runSpacing: ZxSpace.xs, children: [for (final c in codes) SelectableText(c, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700, fontSize: 16))]),
        const SizedBox(height: ZxSpace.md),
        OutlinedButton.icon(onPressed: () async { await Clipboard.setData(ClipboardData(text: codes.join('\n'))); if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied. Paste them somewhere safe, then clear your clipboard.'))); }, icon: const Icon(Icons.copy), label: const Text('Copy codes')),
        const SizedBox(height: ZxSpace.sm),
        ZxButton(label: 'I have saved them', onPressed: onDone),
      ]));
}

/// Owns its text controller, so it is disposed only after the dialog has fully closed.
class _CodeDialog extends StatefulWidget {
  const _CodeDialog({required this.title});
  final String title;
  @override
  State<_CodeDialog> createState() => _CodeDialogState();
}

class _CodeDialogState extends State<_CodeDialog> {
  final _c = TextEditingController();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: TextField(controller: _c, autofocus: true, maxLength: 14, decoration: const InputDecoration(labelText: 'Authenticator code or recovery code')),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(context, _c.text.trim()), child: const Text('Confirm'))],
      );
}
