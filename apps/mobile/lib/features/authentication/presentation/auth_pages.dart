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
  bool _remember = false;

  @override
  void dispose() { _id.dispose(); _pw.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(title: 'Welcome back', children: [
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
          ZxErrorText(error),
          ZxButton(
            label: 'Sign in',
            loading: busy,
            onPressed: () { if (_form.currentState!.validate()) run(() => ref.read(authControllerProvider.notifier).login(_id.text, _pw.text, remember: _remember)); },
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

class _RegisterPageState extends ConsumerState<RegisterPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController(), _user = TextEditingController(), _email = TextEditingController(), _pw = TextEditingController();

  @override
  void dispose() { for (final c in [_name, _user, _email, _pw]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(title: 'Create your account', back: true, children: [
      Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextFormField(controller: _name, decoration: InputDecoration(labelText: 'Full name', errorText: fieldErrors['fullName']), validator: _required, textInputAction: TextInputAction.next),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _user, decoration: InputDecoration(labelText: 'Username', errorText: fieldErrors['username']), validator: (v) => RegExp(r'^[A-Za-z0-9_.]{3,30}$').hasMatch(v ?? '') ? null : '3-30 letters, digits, _ or .'),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _email, decoration: InputDecoration(labelText: 'Email', errorText: fieldErrors['email']), keyboardType: TextInputType.emailAddress, validator: (v) => (v ?? '').contains('@') ? null : 'Enter a valid email'),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _pw, decoration: InputDecoration(labelText: 'Password', helperText: 'At least 10 characters with upper, lower and a digit', errorText: fieldErrors['password']), obscureText: true, validator: (v) => (v ?? '').length >= 10 ? null : 'At least 10 characters'),
          const SizedBox(height: ZxSpace.md),
          ZxErrorText(error),
          ZxButton(
            label: 'Continue',
            loading: busy,
            onPressed: () {
              if (!_form.currentState!.validate()) return;
              final router = GoRouter.of(context);
              run(() async {
                await ref.read(authControllerProvider.notifier).register(fullName: _name.text.trim(), username: _user.text.trim(), email: _email.text.trim(), password: _pw.text);
                router.go('/');
              });
            },
          ),
        ]),
      ),
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
        ZxButton(label: 'Send reset link', loading: busy, onPressed: () => run(() async {
          await repo.requestPasswordReset(_id.text.trim());
          if (mounted) setState(() => _requested = true);
        })),
      ] else ...[
        const Text('If that account exists, we have sent reset instructions. Enter the code you received and choose a new password.'),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _token, decoration: const InputDecoration(labelText: 'Reset code')),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _pw, obscureText: true, decoration: InputDecoration(labelText: 'New password', errorText: fieldErrors['password'])),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Change password', loading: busy, onPressed: () => run(() async {
          await repo.confirmPasswordReset(_token.text.trim(), _pw.text);
          if (mounted) setState(() => _done = true);
        })),
      ],
    ]);
  }
}
