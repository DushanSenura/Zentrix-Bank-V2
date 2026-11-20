import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design_system/tokens.dart';
import '../../core/utils/no_retry.dart';
import '../../core/design_system/widgets.dart';
import '../../core/security/biometric_service.dart';
import '../authentication/data/auth_repository.dart';
import '../authentication/presentation/auth_controller.dart';
import '../authentication/presentation/auth_pages.dart';
import '../settings/settings_controller.dart';

final _sessionsProvider = FutureProvider.autoDispose((ref) => ref.watch(authRepositoryProvider).sessions(), retry: noRetry);
final _historyProvider = FutureProvider.autoDispose((ref) => ref.watch(authRepositoryProvider).loginHistory(), retry: noRetry);
final _devicesProvider = FutureProvider.autoDispose((ref) => ref.watch(authRepositoryProvider).devices(), retry: noRetry);

String _when(DateTime t) {
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
}

/// Page frame for list-style security screens with loading / error / empty states.
class _ListFrame<T> extends StatelessWidget {
  const _ListFrame({required this.title, required this.value, required this.onRetry, required this.itemBuilder, required this.empty, this.footer});
  final String title;
  final AsyncValue<List<T>> value;
  final VoidCallback onRetry;
  final Widget Function(T) itemBuilder;
  final String empty;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ZxBackdrop(
        child: SafeArea(
          child: value.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(e is ApiFailure ? e.message : 'Something went wrong.'),
              TextButton(onPressed: onRetry, child: const Text('Retry')),
            ])),
            data: (items) => ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
              if (items.isEmpty) Padding(padding: const EdgeInsets.all(ZxSpace.lg), child: Text(empty, textAlign: TextAlign.center)),
              for (final i in items) Padding(padding: const EdgeInsets.only(bottom: ZxSpace.sm), child: GlassCard(blur: false, padding: const EdgeInsets.all(ZxSpace.md), child: itemBuilder(i))),
              ?footer,
            ]),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────── hub ─────────────────────────
class SecurityCenterPage extends ConsumerWidget {
  const SecurityCenterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Widget tile(IconData i, String t, String route) => ListTile(leading: Icon(i), title: Text(t), trailing: const Icon(Icons.chevron_right), onTap: () => context.push(route));
    return Scaffold(
      appBar: AppBar(title: const Text('Security & settings')),
      body: ZxBackdrop(
        child: SafeArea(
          child: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(blur: false, padding: EdgeInsets.zero, child: Material(type: MaterialType.transparency, child: Column(children: [
              tile(Icons.lock_outline, 'Change password', '/security/password'),
              tile(Icons.pin_outlined, 'Change app PIN', '/security/pin'),
              tile(Icons.devices_other, 'Active sessions', '/security/sessions'),
              tile(Icons.verified_user_outlined, 'Trusted devices', '/security/devices'),
              tile(Icons.history, 'Login history', '/security/history'),
              tile(Icons.phonelink_lock, 'Two-step sign-in', '/security/2fa'),
              tile(Icons.speed, 'Transfer limits', '/security/limits'),
              tile(Icons.tune, 'App lock & appearance', '/security/preferences'),
            ]))),
          ]),
        ),
      ),
    );
  }
}

// ───────────────────────── change password / PIN ─────────────────────────
class ChangePasswordPage extends ConsumerStatefulWidget {
  const ChangePasswordPage({super.key});
  @override
  ConsumerState<ChangePasswordPage> createState() => _ChangePasswordPageState();
}

class _ChangePasswordPageState extends ConsumerState<ChangePasswordPage> with FormRunner {
  final _cur = TextEditingController(), _next = TextEditingController();
  bool _done = false;
  @override
  void dispose() { _cur.dispose(); _next.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(title: _done ? 'Password changed' : 'Change password', back: true, children: [
      if (_done)
        const Text('Your password was updated and your other devices were signed out.', textAlign: TextAlign.center)
      else ...[
        TextField(controller: _cur, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
        const SizedBox(height: ZxSpace.md),
        TextField(controller: _next, obscureText: true, decoration: InputDecoration(labelText: 'New password', helperText: 'At least 10 characters with upper, lower and a digit', errorText: fieldErrors['next'])),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Update password', loading: busy, onPressed: () => run(() async {
          await ref.read(authRepositoryProvider).changePassword(_cur.text, _next.text);
          if (mounted) setState(() => _done = true);
        })),
      ],
    ]);
  }
}

class ChangePinPage extends ConsumerStatefulWidget {
  const ChangePinPage({super.key});
  @override
  ConsumerState<ChangePinPage> createState() => _ChangePinPageState();
}

class _ChangePinPageState extends ConsumerState<ChangePinPage> with FormRunner {
  final _cur = TextEditingController(), _next = TextEditingController(), _confirm = TextEditingController();
  bool _done = false;
  @override
  void dispose() { _cur.dispose(); _next.dispose(); _confirm.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    TextField pin(TextEditingController c, String label, {String? err}) => TextField(controller: c, obscureText: true, keyboardType: TextInputType.number, maxLength: 6, decoration: InputDecoration(labelText: label, counterText: '', errorText: err));
    return AuthScaffold(title: _done ? 'PIN changed' : 'Change app PIN', back: true, children: [
      if (_done)
        const Text('Your app PIN was updated.', textAlign: TextAlign.center)
      else ...[
        pin(_cur, 'Current PIN'),
        const SizedBox(height: ZxSpace.md),
        pin(_next, 'New PIN (4 or 6 digits)', err: fieldErrors['newPin']),
        const SizedBox(height: ZxSpace.md),
        pin(_confirm, 'Confirm new PIN'),
        const SizedBox(height: ZxSpace.md),
        ZxErrorText(error),
        ZxButton(label: 'Update PIN', loading: busy, onPressed: () {
          if (_next.text != _confirm.text) { setState(() => error = 'New PINs do not match'); return; }
          run(() async {
            try {
              await ref.read(authRepositoryProvider).changePin(_cur.text, _next.text);
              if (mounted) setState(() => _done = true);
            } on ApiFailure catch (e) {
              if (e.code == 'unauthenticated') await ref.read(authControllerProvider.notifier).logout(); // PIN lockout ended the session
              rethrow;
            }
          });
        }),
      ],
    ]);
  }
}

// ───────────────────────── sessions / devices / history ─────────────────────────
class SessionsPage extends ConsumerWidget {
  const SessionsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(authRepositoryProvider);
    return _ListFrame<SessionInfo>(
      title: 'Active sessions',
      value: ref.watch(_sessionsProvider),
      onRetry: () => ref.invalidate(_sessionsProvider),
      empty: 'No active sessions.',
      itemBuilder: (s) => Row(children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(s.current ? 'This device' : (s.userAgent ?? 'Another device'), style: const TextStyle(fontWeight: FontWeight.w700)),
          Text('Signed in ${_when(s.createdAt)}${s.ip != null ? ' · ${s.ip}' : ''}'),
        ])),
        if (!s.current) TextButton(onPressed: () async { await repo.revokeSession(s.id); ref.invalidate(_sessionsProvider); }, child: const Text('Sign out')),
      ]),
      footer: TextButton(onPressed: () async { await repo.revokeOtherSessions(); ref.invalidate(_sessionsProvider); }, child: const Text('Sign out all other devices')),
    );
  }
}

class DevicesPage extends ConsumerWidget {
  const DevicesPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _ListFrame<DeviceInfo>(
      title: 'Trusted devices',
      value: ref.watch(_devicesProvider),
      onRetry: () => ref.invalidate(_devicesProvider),
      empty: 'No trusted devices. Tick "Remember this device" when you sign in to add one.',
      itemBuilder: (d) => Row(children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(d.label ?? 'Device', style: const TextStyle(fontWeight: FontWeight.w700)),
          Text('Trusted since ${_when(d.trustedAt)}'),
        ])),
        TextButton(onPressed: () async { await ref.read(authRepositoryProvider).removeDevice(d.id); ref.invalidate(_devicesProvider); }, child: const Text('Remove')),
      ]),
    );
  }
}

class LoginHistoryPage extends ConsumerWidget {
  const LoginHistoryPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _ListFrame<LoginEntry>(
      title: 'Login history',
      value: ref.watch(_historyProvider),
      onRetry: () => ref.invalidate(_historyProvider),
      empty: 'No sign-ins recorded yet.',
      itemBuilder: (h) => Row(children: [
        Icon(h.success ? Icons.check_circle_outline : Icons.error_outline, color: h.success ? context.zx.success : context.zx.error),
        const SizedBox(width: ZxSpace.sm),
        Expanded(child: Text('${h.success ? 'Signed in' : 'Failed attempt'} · ${_when(h.at)}${h.ip != null ? ' · ${h.ip}' : ''}')),
      ]),
    );
  }
}

// ───────────────────────── app lock & appearance ─────────────────────────
class PreferencesPage extends ConsumerWidget {
  const PreferencesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(settingsProvider);
    final n = ref.read(settingsProvider.notifier);
    return Scaffold(
      appBar: AppBar(title: const Text('App lock & appearance')),
      body: ZxBackdrop(
        child: SafeArea(
          child: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(blur: false, padding: EdgeInsets.zero, child: Material(type: MaterialType.transparency, child: Column(children: [
              SwitchListTile(
                title: const Text('Unlock with biometrics'),
                subtitle: const Text('Uses your phone’s fingerprint or face unlock. The bank never receives biometric data.'),
                value: s.biometric,
                onChanged: (v) async {
                  final bio = ref.read(biometricServiceProvider);
                  final messenger = ScaffoldMessenger.of(context);
                  if (!v) return n.setBiometric(false);
                  if (!await bio.available()) { messenger.showSnackBar(const SnackBar(content: Text('No biometrics are set up on this phone.'))); return; }
                  if (await bio.authenticate('Confirm to turn on biometric unlock')) await n.setBiometric(true);
                },
              ),
              ListTile(
                title: const Text('Auto-lock after'),
                trailing: DropdownButton<int>(
                  value: s.lockMinutes,
                  onChanged: (v) => n.setLockMinutes(v ?? 2),
                  items: const [DropdownMenuItem(value: 0, child: Text('Immediately')), DropdownMenuItem(value: 1, child: Text('1 minute')), DropdownMenuItem(value: 2, child: Text('2 minutes')), DropdownMenuItem(value: 5, child: Text('5 minutes')), DropdownMenuItem(value: 15, child: Text('15 minutes'))],
                ),
              ),
              ListTile(
                title: const Text('Theme'),
                trailing: DropdownButton<ThemeMode>(
                  value: s.themeMode,
                  onChanged: (v) => n.setTheme(v ?? ThemeMode.system),
                  items: const [DropdownMenuItem(value: ThemeMode.system, child: Text('System')), DropdownMenuItem(value: ThemeMode.light, child: Text('Light')), DropdownMenuItem(value: ThemeMode.dark, child: Text('Dark'))],
                ),
              ),
              SwitchListTile(title: const Text('Reduce motion'), subtitle: const Text('Also follows your phone’s setting'), value: s.reduceMotion, onChanged: n.setReduceMotion),
            ]))),
          ]),
        ),
      ),
    );
  }
}
