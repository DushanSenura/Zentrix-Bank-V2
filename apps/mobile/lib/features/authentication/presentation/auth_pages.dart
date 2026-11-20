import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../data/auth_repository.dart';
import 'auth_controller.dart';

/// Shared chrome for auth screens: gradient backdrop, scrollable glass card, logo.
class AuthScaffold extends StatelessWidget {
  const AuthScaffold({super.key, required this.title, required this.children, this.back = false});
  final String title;
  final List<Widget> children;
  final bool back;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: back ? AppBar(backgroundColor: Colors.transparent, elevation: 0) : null,
      body: ZxBackdrop(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(ZxSpace.md),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: GlassCard(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Image.asset('assets/brand/bank_logo.png', height: 72, semanticLabel: 'Zentrix Bank logo'),
                    const SizedBox(height: ZxSpace.md),
                    Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: ZxSpace.lg),
                    ...children,
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Runs [action], turning ApiFailure into a message. Used by every auth form.
mixin FormRunner<T extends StatefulWidget> on State<T> {
  bool busy = false;
  String? error;
  Map<String, String> fieldErrors = const {};

  Future<void> run(Future<void> Function() action) async {
    setState(() { busy = true; error = null; fieldErrors = const {}; });
    try {
      await action();
    } on ApiFailure catch (e) {
      if (mounted) setState(() { error = e.message; fieldErrors = e.fields; });
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

String? _required(String? v) => (v == null || v.trim().isEmpty) ? 'Required' : null;

// ───────────────────────── Login ─────────────────────────
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});
  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  final _id = TextEditingController();
  final _pw = TextEditingController();
  final _code = TextEditingController();
  bool _remember = false;
  bool _needCode = false; // the bank asked for the second step
  bool _useRecovery = false;

  @override
  void dispose() { _id.dispose(); _pw.dispose(); _code.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final notice = ref.watch(authControllerProvider.select((s) => s.notice));
    return AuthScaffold(title: 'Welcome back', children: [
      if (notice != null) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.md), child: Semantics(liveRegion: true, child: Text(notice, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.error)))),
      Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextFormField(controller: _id, decoration: const InputDecoration(labelText: 'Username, email or customer ID'), autofillHints: const [AutofillHints.username], validator: _required, textInputAction: TextInputAction.next),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _pw, decoration: const InputDecoration(labelText: 'Password'), obscureText: true, autofillHints: const [AutofillHints.password], validator: _required),
          Material(
            type: MaterialType.transparency,
            child: CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, value: _remember, onChanged: (v) => setState(() => _remember = v ?? false), title: const Text('Remember this device')),
          ),
          if (_needCode) ...[
            const SizedBox(height: ZxSpace.sm),
            TextFormField(controller: _code, autofocus: true, keyboardType: _useRecovery ? TextInputType.text : TextInputType.number, maxLength: _useRecovery ? 14 : 6, autofillHints: const [AutofillHints.oneTimeCode], decoration: InputDecoration(labelText: _useRecovery ? 'Recovery code' : 'Authenticator code', helperText: _useRecovery ? 'One of the codes you saved when you turned on two-step sign-in' : 'The 6-digit code from your authenticator app'), validator: _required),
            TextButton(onPressed: () => setState(() { _useRecovery = !_useRecovery; _code.clear(); }), child: Text(_useRecovery ? 'Use my authenticator app' : 'Use a recovery code')),
          ],
          ZxErrorText(error),
          ZxButton(
            label: _needCode ? 'Verify and sign in' : 'Sign in',
            loading: busy,
            onPressed: () {
              if (!_form.currentState!.validate()) return;
              run(() async {
                try {
                  await ref.read(authControllerProvider.notifier).login(_id.text, _pw.text, remember: _remember, mfaCode: _needCode && !_useRecovery ? _code.text.trim() : null, recoveryCode: _needCode && _useRecovery ? _code.text.trim() : null);
                } on ApiFailure catch (e) {
                  if (e.code == 'mfa_required') { setState(() => _needCode = true); return; } // ask for the code instead of showing an error
                  rethrow;
                }
              });
            },
          ),
          TextButton(onPressed: () => context.push('/forgot'), child: const Text('Forgot password?')),
          if (kDebugMode) _DemoAccounts(onPick: (u, p) => setState(() { _id.text = u; _pw.text = p; })),
          TextButton(onPressed: () => context.push('/register'), child: const Text('Create an account')),
        ]),
      ),
    ]);
  }
}

/// DEBUG BUILDS ONLY (guarded by kDebugMode, so it is compiled out of release builds): the fictional seeded customers, fetched from a
/// local development API. It shows nothing when the server does not offer them.
class _DemoAccounts extends ConsumerStatefulWidget {
  const _DemoAccounts({required this.onPick});
  final void Function(String username, String password) onPick;
  @override
  ConsumerState<_DemoAccounts> createState() => _DemoAccountsState();
}

class _DemoAccountsState extends ConsumerState<_DemoAccounts> {
  late final Future<List<DemoAccount>> _future = Future(() => ref.read(authRepositoryProvider).demoAccounts()).catchError((_) => const <DemoAccount>[]); // any failure just means no demo section

  @override
  Widget build(BuildContext context) => FutureBuilder<List<DemoAccount>>(
        future: _future,
        builder: (context, snap) {
          final items = snap.data ?? const <DemoAccount>[];
          if (items.isEmpty) return const SizedBox.shrink();
          return Card(
            margin: const EdgeInsets.only(top: ZxSpace.md),
            child: Padding(
              padding: const EdgeInsets.all(ZxSpace.md),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Demo customers (development only, fictional)', style: TextStyle(fontWeight: FontWeight.w600)),
                for (final a in items)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: Text(a.fullName),
                    subtitle: SelectableText([a.username, a.password, if (a.pin != null) 'App PIN: ${a.pin}'].join('\n')),
                    isThreeLine: true,
                    trailing: TextButton(onPressed: () => widget.onPick(a.username, a.password), child: const Text('Use')),
                  ),
              ]),
            ),
          );
        },
      );
}

// ───────────────────────── Register ─────────────────────────
class RegisterPage extends ConsumerStatefulWidget {
  const RegisterPage({super.key});
  @override
  ConsumerState<RegisterPage> createState() => _RegisterPageState();
}

/// Five steps: personal details, contact details, sign-in details, identity, review. Nothing is sent until the last step.
/// The bank then creates the profile and submits the identity details for staff review in one go.
class _RegisterPageState extends ConsumerState<RegisterPage> with FormRunner {
  static const _steps = ['Personal', 'Contact', 'Sign-in', 'Identity', 'Review'];
  final _forms = List.generate(5, (_) => GlobalKey<FormState>());
  final _name = TextEditingController(), _dob = TextEditingController(), _nid = TextEditingController();
  final _email = TextEditingController(), _phone = TextEditingController(), _l1 = TextEditingController(), _city = TextEditingController(), _zip = TextEditingController();
  final _user = TextEditingController(), _pw = TextEditingController(), _pw2 = TextEditingController();
  int _step = 0;
  bool _confirmed = false;

  @override
  void dispose() { for (final c in [_name, _dob, _nid, _email, _phone, _l1, _city, _zip, _user, _pw, _pw2]) { c.dispose(); } super.dispose(); }

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final d = await showDatePicker(context: context, initialDate: DateTime(now.year - 30), firstDate: DateTime(now.year - 100), lastDate: DateTime(now.year - 18, now.month, now.day), helpText: 'Date of birth (18 or older)');
    if (d != null) setState(() => _dob.text = '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}');
  }

  void _next() {
    if (!(_forms[_step].currentState?.validate() ?? false)) return;
    if (_step == 3 && !_confirmed) { setState(() => error = 'Please confirm the details match your national ID.'); return; }
    setState(() { error = null; _step++; });
  }

  Future<void> _submit() async {
    final router = GoRouter.of(context);
    await run(() async {
      await ref.read(authControllerProvider.notifier).register(fullName: _name.text.trim(), username: _user.text.trim(), email: _email.text.trim(), password: _pw.text, phone: _phone.text.trim().isEmpty ? null : _phone.text.trim());
      try {
        await ref.read(authRepositoryProvider).submitKyc(nationalId: _nid.text.trim(), dateOfBirth: _dob.text.trim(), line1: _l1.text.trim(), city: _city.text.trim(), postalCode: _zip.text.trim());
        await ref.read(authControllerProvider.notifier).refreshMe();
      } on ApiFailure {
        // The account exists and the customer is signed in. The identity step is offered again on the next screen.
      }
      router.go('/');
    });
    // A refusal about one field (a taken username, a weak password) sends the customer back to the step that has it.
    if (mounted && fieldErrors.isNotEmpty) {
      final back = fieldErrors.containsKey('fullName') ? 0 : (fieldErrors.containsKey('email') || fieldErrors.containsKey('phone')) ? 1 : (fieldErrors.containsKey('username') || fieldErrors.containsKey('password')) ? 2 : fieldErrors.containsKey('nationalId') ? 3 : null;
      if (back != null) setState(() => _step = back);
    }
  }

  Widget _gap() => const SizedBox(height: ZxSpace.md);

  Widget _review(String k, String v) => Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 120, child: Text(k)), Expanded(child: Text(v, style: const TextStyle(fontWeight: FontWeight.w600)))]));

  @override
  Widget build(BuildContext context) {
    final fields = <Widget>[
      // 1. personal
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextFormField(controller: _name, decoration: InputDecoration(labelText: 'Full name', errorText: fieldErrors['fullName']), validator: (v) => (v ?? '').trim().length >= 2 ? null : 'Enter your full name', textInputAction: TextInputAction.next),
        _gap(),
        TextFormField(controller: _dob, readOnly: true, onTap: _pickDob, decoration: const InputDecoration(labelText: 'Date of birth', suffixIcon: Icon(Icons.event)), validator: (v) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(v ?? '') ? null : 'Choose your date of birth'),
      ]),
      // 2. contact
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextFormField(controller: _email, decoration: InputDecoration(labelText: 'Email', errorText: fieldErrors['email']), keyboardType: TextInputType.emailAddress, validator: (v) => (v ?? '').contains('@') ? null : 'Enter a valid email'),
        _gap(),
        TextFormField(controller: _phone, decoration: InputDecoration(labelText: 'Mobile number (optional)', errorText: fieldErrors['phone']), keyboardType: TextInputType.phone, validator: (v) => (v ?? '').trim().isEmpty || RegExp(r'^\+?[0-9 ]{7,16}$').hasMatch(v!.trim()) ? null : 'Enter a valid number'),
        _gap(),
        TextFormField(controller: _l1, decoration: const InputDecoration(labelText: 'Address'), validator: _required, textInputAction: TextInputAction.next),
        _gap(),
        Row(children: [
          Expanded(child: TextFormField(controller: _city, decoration: const InputDecoration(labelText: 'City'), validator: _required)),
          const SizedBox(width: ZxSpace.sm),
          Expanded(child: TextFormField(controller: _zip, decoration: const InputDecoration(labelText: 'Postal code'), validator: _required)),
        ]),
      ]),
      // 3. sign-in
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextFormField(controller: _user, decoration: InputDecoration(labelText: 'Username', errorText: fieldErrors['username']), validator: (v) => RegExp(r'^[A-Za-z0-9_.]{3,30}$').hasMatch(v ?? '') ? null : '3-30 letters, digits, _ or .'),
        _gap(),
        TextFormField(controller: _pw, decoration: InputDecoration(labelText: 'Password', helperText: 'At least 10 characters with upper, lower and a digit', errorText: fieldErrors['password']), obscureText: true, validator: (v) => (v ?? '').length >= 10 ? null : 'At least 10 characters'),
        _gap(),
        TextFormField(controller: _pw2, decoration: const InputDecoration(labelText: 'Confirm password'), obscureText: true, validator: (v) => v == _pw.text ? null : 'Passwords do not match'),
      ]),
      // 4. identity
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text('The bank checks your identity before you can open an account. Staff review these details; nothing is approved automatically.'),
        _gap(),
        TextFormField(controller: _nid, decoration: InputDecoration(labelText: 'National ID number', errorText: fieldErrors['nationalId']), validator: (v) => RegExp(r'^[A-Za-z0-9]{5,20}$').hasMatch(v ?? '') ? null : 'Enter a valid ID number'),
        CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, value: _confirmed, onChanged: (v) => setState(() => _confirmed = v ?? false), title: const Text('These details match my national ID.')),
      ]),
      // 5. review
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _review('Name', _name.text), _review('Date of birth', _dob.text), _review('Email', _email.text), _review('Mobile', _phone.text.isEmpty ? '—' : _phone.text),
        _review('Address', '${_l1.text}, ${_city.text} ${_zip.text}'), _review('Username', _user.text), _review('National ID', _nid.text),
        const Padding(padding: EdgeInsets.only(top: ZxSpace.sm), child: Text('After you submit, you set your app PIN. You can open accounts once the bank has verified your identity.')),
      ]),
    ];
    return AuthScaffold(title: 'Create your account', back: true, children: [
      Semantics(label: 'Step ${_step + 1} of ${_steps.length}: ${_steps[_step]}', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LinearProgressIndicator(value: (_step + 1) / _steps.length),
        const SizedBox(height: ZxSpace.xs),
        Text('Step ${_step + 1} of ${_steps.length}: ${_steps[_step]}', style: Theme.of(context).textTheme.titleSmall),
      ])),
      _gap(),
      Form(key: _forms[_step], child: fields[_step]),
      _gap(),
      ZxErrorText(error),
      Row(children: [
        if (_step > 0) Expanded(child: OutlinedButton(onPressed: busy ? null : () => setState(() { error = null; _step--; }), child: const Text('Back'))),
        if (_step > 0) const SizedBox(width: ZxSpace.sm),
        Expanded(child: ZxButton(label: _step == _steps.length - 1 ? 'Create account' : 'Continue', loading: busy, onPressed: _step == _steps.length - 1 ? _submit : _next)),
      ]),
    ]);
  }
}

// ───────────────────────── Forgot / reset ─────────────────────────
class ForgotPasswordPage extends ConsumerStatefulWidget {
  const ForgotPasswordPage({super.key});
  @override
  ConsumerState<ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends ConsumerState<ForgotPasswordPage> with FormRunner {
  final _id = TextEditingController(), _token = TextEditingController(), _pw = TextEditingController();
  bool _requested = false;
  bool _done = false;
  String? _devCode;

  @override
  void dispose() { _id.dispose(); _token.dispose(); _pw.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final repo = ref.read(authRepositoryProvider);
    if (_done) {
      return AuthScaffold(title: 'Password updated', back: true, children: [
        const Text('Your password has been changed and all devices were signed out.', textAlign: TextAlign.center),
        const SizedBox(height: ZxSpace.md),
        ZxButton(label: 'Back to sign in', onPressed: () => context.go('/login')),
      ]);
    }
    return AuthScaffold(title: 'Reset password', back: true, children: [
      if (!_requested) ...[
        TextField(controller: _id, decoration: const InputDecoration(labelText: 'Username or email')),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Send verification code', loading: busy, onPressed: () => run(() async {
          await repo.requestPasswordReset(_id.text.trim());
          final dev = await repo.devResetCode(_id.text.trim());
          if (mounted) setState(() { _requested = true; _devCode = dev; });
        })),
      ] else ...[
        const Text('If that account exists, we have sent a 6-digit verification code. It works for 30 minutes and allows 5 attempts.'),
        if (_devCode != null) Padding(padding: const EdgeInsets.only(top: ZxSpace.sm), child: Text('Development only: your code is $_devCode', style: const TextStyle(fontWeight: FontWeight.w600))),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _token, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'Verification code')),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _pw, obscureText: true, decoration: InputDecoration(labelText: 'New password', errorText: fieldErrors['password'])),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Change password', loading: busy, onPressed: () => run(() async {
          await repo.confirmPasswordReset(_id.text.trim(), _token.text.trim(), _pw.text);
          if (mounted) setState(() => _done = true);
        })),
      ],
    ]);
  }
}
