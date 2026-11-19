import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/security/biometric_service.dart';
import '../../settings/settings_controller.dart';
import '../data/auth_repository.dart';
import 'auth_controller.dart';
import 'auth_pages.dart';

/// Wraps the whole app: (1) hides content in the app switcher, (2) locks after the idle timeout.
class AppLockGate extends ConsumerStatefulWidget {
  const AppLockGate({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends ConsumerState<AppLockGate> with WidgetsBindingObserver {
  DateTime? _leftAt;
  bool _covered = false;

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    final auth = ref.read(authControllerProvider);
    if (!auth.signedIn) return;
    if (s == AppLifecycleState.resumed) {
      final left = _leftAt;
      _leftAt = null;
      final mins = ref.read(settingsProvider).lockMinutes;
      if (left != null && auth.me!.hasPin && DateTime.now().difference(left) >= Duration(minutes: mins)) {
        ref.read(lockProvider.notifier).lock();
      }
      setState(() => _covered = false);
    } else {
      _leftAt ??= DateTime.now();
      setState(() => _covered = true); // privacy cover for the app switcher
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      widget.child,
      if (_covered)
        Positioned.fill(
          child: ZxBackdrop(child: Center(child: Image.asset('assets/brand/bank_logo.png', height: 96, excludeFromSemantics: true))),
        ),
    ]);
  }
}

class UnlockPage extends ConsumerStatefulWidget {
  const UnlockPage({super.key});
  @override
  ConsumerState<UnlockPage> createState() => _UnlockPageState();
}

class _UnlockPageState extends ConsumerState<UnlockPage> with FormRunner {
  final _pin = TextEditingController();
  bool _bioAvailable = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(_initBio);
  }

  @override
  void dispose() { _pin.dispose(); super.dispose(); }

  Future<void> _initBio() async {
    final bio = ref.read(biometricServiceProvider);
    final enabled = ref.read(settingsProvider).biometric;
    final ok = enabled && await bio.available();
    if (!mounted) return;
    setState(() => _bioAvailable = ok);
    if (ok) await _bio();
  }

  Future<void> _bio() async {
    // The OS only returns yes/no; the server session is already valid, so success simply lifts the local lock.
    if (await ref.read(biometricServiceProvider).authenticate('Unlock Zentrix Bank')) {
      ref.read(lockProvider.notifier).unlock();
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = ref.watch(authControllerProvider).me?.fullName.split(' ').first ?? '';
    return AuthScaffold(title: 'Welcome back, $name', children: [
      TextField(
        controller: _pin,
        obscureText: true,
        keyboardType: TextInputType.number,
        maxLength: 6,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Enter your PIN', counterText: ''),
        onSubmitted: (_) => _submit(),
      ),
      const SizedBox(height: ZxSpace.sm),
      ZxErrorText(error),
      ZxButton(label: 'Unlock', loading: busy, onPressed: _submit),
      if (_bioAvailable) TextButton.icon(onPressed: _bio, icon: const Icon(Icons.fingerprint), label: const Text('Use biometrics')),
      TextButton(onPressed: () => ref.read(authControllerProvider.notifier).logout(), child: const Text('Sign out')),
    ]);
  }

  void _submit() => run(() async {
        try {
          // PIN is verified by the SERVER (rate-limited; 5 failures end the session everywhere).
          await ref.read(authRepositoryProvider).verifyPin(_pin.text);
          ref.read(lockProvider.notifier).unlock();
        } on ApiFailure catch (e) {
          _pin.clear();
          if (e.code == 'unauthenticated' || e.code == 'session_expired') {
            await ref.read(authControllerProvider.notifier).logout();
            return;
          }
          rethrow;
        }
      });
}
