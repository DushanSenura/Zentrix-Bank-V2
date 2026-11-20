import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/design_system/async_view.dart';
import '../../core/design_system/tokens.dart';
import '../../core/design_system/widgets.dart';
import '../../core/utils/money.dart';
import '../accounts/data/accounts_repository.dart';
import '../authentication/presentation/auth_controller.dart';
import '../payments/presentation/payment_flow.dart' show askPin;
import '../payments/presentation/payments_pages.dart' show unreadCountProvider;
import '../settings/settings_controller.dart';
import 'profile_repository.dart';

void _toast(BuildContext c, String m) => ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(m)));

// ═════════════════════════ profile ═════════════════════════
class ProfilePage extends ConsumerWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(authControllerProvider).me;
    final unread = ref.watch(unreadCountProvider).asData?.value ?? 0;
    Widget tile(IconData i, String t, String route, {Widget? trailing}) => ListTile(minTileHeight: 56, leading: Icon(i), title: Text(t), trailing: trailing ?? const Icon(Icons.chevron_right), onTap: () => context.push(route));
    return ServicePage(
      title: 'Profile',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        GlassCard(blur: false, child: Row(children: [
          CircleAvatar(radius: 28, child: Text(((me?.fullName ?? '').isEmpty ? '?' : me!.fullName[0]).toUpperCase(), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800))),
          const SizedBox(width: ZxSpace.md),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(me?.fullName ?? '', style: Theme.of(context).textTheme.titleLarge),
            if (me?.customerNumber != null) Text('Customer ${me!.customerNumber}'),
          ])),
        ])),
        const SizedBox(height: ZxSpace.md),
        GlassCard(blur: false, padding: EdgeInsets.zero, child: Material(type: MaterialType.transparency, child: Column(children: [
          tile(Icons.person_outline, 'Personal details', '/profile/edit'),
          tile(Icons.notifications_none, 'Notifications', '/notifications', trailing: unread > 0 ? Badge(label: Text('$unread'), child: const Icon(Icons.chevron_right)) : null),
          tile(Icons.shield_outlined, 'Security centre', '/security'),
          tile(Icons.settings_outlined, 'Settings', '/settings'),
          tile(Icons.support_agent, 'Help and support', '/support'),
        ]))),
        const SizedBox(height: ZxSpace.md),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52), foregroundColor: Theme.of(context).colorScheme.error),
          icon: const Icon(Icons.logout),
          label: const Text('Sign out'),
          onPressed: () async {
            final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: const Text('Sign out?'), content: const Text('You will need to sign in again.'), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Sign out'))]));
            if (ok == true) await ref.read(authControllerProvider.notifier).logout();
          },
        ),
      ]),
    );
  }
}

// ═════════════════════════ personal details ═════════════════════════
class EditProfilePage extends ConsumerStatefulWidget {
  const EditProfilePage({super.key});
  @override
  ConsumerState<EditProfilePage> createState() => _EditProfilePageState();
}

class _EditProfilePageState extends ConsumerState<EditProfilePage> {
  final _email = TextEditingController();
  final _phone = TextEditingController();
  bool _seeded = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save(ProfileView p) async {
    final email = _email.text.trim();
    final phone = _phone.text.trim();
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)) return setState(() => _error = 'Enter a valid email address.');
    if (phone.isNotEmpty && !RegExp(r'^\+?[0-9 ]{7,16}$').hasMatch(phone)) return setState(() => _error = 'Enter a valid mobile number.');
    if (email == p.email && phone == (p.phone ?? '')) return setState(() => _error = 'Nothing has changed.');
    final pin = await askPin(context);
    if (pin == null || !mounted) return;
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(profileRepositoryProvider).updateContact(email: email == p.email ? null : email, phone: phone == (p.phone ?? '') || phone.isEmpty ? null : phone, pin: pin);
      ref.invalidate(profileProvider);
      if (mounted) _toast(context, 'Contact details saved.');
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget ro(String label, String? value) => Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Semantics(label: '$label: ${value ?? 'not provided'}', excludeSemantics: true, child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 130, child: Text(label, style: TextStyle(color: context.zx.textMuted))), Expanded(child: Text(value ?? '–'))])));
    return ServicePage(
      title: 'Personal details',
      body: AsyncView<ProfileView>(
        value: ref.watch(profileProvider),
        onRetry: () => ref.invalidate(profileProvider),
        builder: (p) {
          if (!_seeded) { _seeded = true; _email.text = p.email; _phone.text = p.phone ?? ''; }
          return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
            GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Verified by the bank', style: Theme.of(context).textTheme.titleSmall),
              ro('Name', p.fullName), ro('Customer ID', p.customerNumber), ro('Username', p.username), ro('Date of birth', p.dateOfBirth), ro('Address', p.addressLine), ro('National ID', p.hasNationalId ? '••••••••' : null),
              const SizedBox(height: ZxSpace.xs),
              const Text('To change verified details, contact the bank.', style: TextStyle(fontSize: 12)),
            ])),
            const SizedBox(height: ZxSpace.md),
            GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Contact details', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: ZxSpace.sm),
              TextField(controller: _email, keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email], decoration: const InputDecoration(labelText: 'Email')),
              const SizedBox(height: ZxSpace.md),
              TextField(controller: _phone, keyboardType: TextInputType.phone, autofillHints: const [AutofillHints.telephoneNumber], decoration: const InputDecoration(labelText: 'Mobile number')),
              if (_error != null) ZxErrorText(_error!),
              const SizedBox(height: ZxSpace.md),
              ZxButton(label: _busy ? 'Saving…' : 'Save changes', onPressed: _busy ? null : () => _save(p)),
              const SizedBox(height: ZxSpace.xs),
              const Text('Changing contact details needs your app PIN, and we tell you about every change.', style: TextStyle(fontSize: 12)),
            ])),
          ]);
        },
      ),
    );
  }
}

// ═════════════════════════ settings ═════════════════════════
class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(settingsProvider);
    final n = ref.read(settingsProvider.notifier);
    final prefs = ref.watch(prefsProvider);
    final accounts = ref.watch(accountListProvider).asData?.value.items.where((a) => a.status == 'ACTIVE').toList() ?? const <Account>[];

    Future<void> savePrefs({String? defaultAccountId, bool clear = false, Map<String, bool>? notifications}) async {
      try {
        await ref.read(profileRepositoryProvider).setPrefs(defaultAccountId: defaultAccountId, clearDefault: clear, notifications: notifications);
        ref.invalidate(prefsProvider);
      } catch (e) {
        if (context.mounted) _toast(context, errorText(e));
      }
    }

    return ServicePage(
      title: 'Settings',
      body: ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
        _Section('Appearance', [
          ListTile(title: const Text('Theme'), trailing: DropdownButton<ThemeMode>(value: s.themeMode, onChanged: (v) => n.setTheme(v ?? ThemeMode.system), items: const [DropdownMenuItem(value: ThemeMode.system, child: Text('System')), DropdownMenuItem(value: ThemeMode.light, child: Text('Light')), DropdownMenuItem(value: ThemeMode.dark, child: Text('Dark'))])),
          const ListTile(title: Text('Language'), subtitle: Text('English. Statements can be produced in Sinhala and Tamil.'), trailing: Text('English')),
          SwitchListTile(title: const Text('Reduce motion'), subtitle: const Text('Also follows your phone’s setting'), value: s.reduceMotion, onChanged: n.setReduceMotion),
        ]),
        _Section('Privacy and lock', [
          SwitchListTile(title: const Text('Show balances'), subtitle: const Text('Turn off to hide amounts on the home screen'), value: !s.hideBalances, onChanged: (v) => n.setHideBalances(!v)),
          ListTile(
            title: const Text('Lock after'),
            subtitle: const Text('Ask for your PIN after being idle or in the background'),
            trailing: DropdownButton<int>(value: s.lockMinutes, onChanged: (v) => n.setLockMinutes(v ?? 2), items: const [DropdownMenuItem(value: 0, child: Text('Immediately')), DropdownMenuItem(value: 1, child: Text('1 minute')), DropdownMenuItem(value: 2, child: Text('2 minutes')), DropdownMenuItem(value: 5, child: Text('5 minutes')), DropdownMenuItem(value: 15, child: Text('15 minutes'))]),
          ),
          ListTile(title: const Text('Security centre'), trailing: const Icon(Icons.chevron_right), onTap: () => context.push('/security')),
          ListTile(title: const Text('Transfer limits'), trailing: const Icon(Icons.chevron_right), onTap: () => context.push('/security/limits')),
        ]),
        _Section('Payments', [
          prefs.when(
            loading: () => const ListTile(title: Text('Default account'), subtitle: Text('Loading…')),
            error: (e, _) => ListTile(title: const Text('Default account'), subtitle: Text(errorText(e))),
            data: (p) {
              final current = accounts.where((a) => a.id == p.defaultAccountId).firstOrNull;
              return ListTile(
                title: const Text('Default account'),
                subtitle: Text(current == null ? 'None. Payments start with your first account.' : '${current.title} ${current.maskedNumber}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: accounts.isEmpty ? null : () async {
                  final id = await showModalBottomSheet<String>(context: context, builder: (c) => SafeArea(child: ListView(shrinkWrap: true, children: [
                    for (final a in accounts) ListTile(title: Text(a.title), subtitle: Text(a.maskedNumber), trailing: a.id == p.defaultAccountId ? const Icon(Icons.check) : null, onTap: () => Navigator.pop(c, a.id)),
                    if (p.defaultAccountId != null) ListTile(title: const Text('No default'), onTap: () => Navigator.pop(c, '')),
                  ])));
                  if (id == null) return;
                  await savePrefs(defaultAccountId: id.isEmpty ? null : id, clear: id.isEmpty);
                },
              );
            },
          ),
        ]),
        _Section('Notifications', [
          prefs.when(
            loading: () => const Padding(padding: EdgeInsets.all(ZxSpace.md), child: Center(child: CircularProgressIndicator())),
            error: (e, _) => ListTile(title: Text(errorText(e))),
            data: (p) => Column(children: [
              for (final e in notificationCategoryLabels.entries)
                SwitchListTile(title: Text(e.value), value: p.notifications[e.key] ?? true, onChanged: (v) => savePrefs(notifications: {e.key: v})),
              const ListTile(title: Text('Security alerts'), subtitle: Text('Always on for your protection'), trailing: Icon(Icons.lock_outline)),
            ]),
          ),
        ]),
      ]),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.children);
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: ZxSpace.md),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(left: ZxSpace.xs, bottom: ZxSpace.xs), child: Text(title, style: Theme.of(context).textTheme.titleSmall)),
          GlassCard(blur: false, padding: EdgeInsets.zero, child: Material(type: MaterialType.transparency, child: Column(children: children))),
        ]),
      );
}

// ═════════════════════════ transfer limits ═════════════════════════
class LimitsPage extends ConsumerStatefulWidget {
  const LimitsPage({super.key});
  @override
  ConsumerState<LimitsPage> createState() => _LimitsPageState();
}

class _LimitsPageState extends ConsumerState<LimitsPage> {
  final _c = TextEditingController();
  bool _seeded = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _save(LimitsView l) async {
    final minor = parseMajorToMinor(_c.text);
    if (minor == null || minor < 100) return setState(() => _error = 'Enter an amount of at least LKR 1.00.');
    if (minor > l.bankMaximumMinor) return setState(() => _error = 'The bank maximum is ${formatMinor(l.bankMaximumMinor)}.');
    if (minor == l.dailyMinor) return setState(() => _error = 'That is already your limit.');
    String? pin;
    if (minor > l.dailyMinor) {
      pin = await askPin(context); // raising a limit needs the PIN; lowering does not
      if (pin == null || !mounted) return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(profileRepositoryProvider).setDailyLimit(minor, pin: pin);
      ref.invalidate(limitsProvider);
      if (mounted) _toast(context, 'Daily limit saved.');
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Transfer limits',
        body: AsyncView<LimitsView>(
          value: ref.watch(limitsProvider),
          onRetry: () => ref.invalidate(limitsProvider),
          builder: (l) {
            if (!_seeded) { _seeded = true; _c.text = (l.dailyMinor / 100).toStringAsFixed(2); }
            final left = (l.dailyMinor - l.usedTodayMinor).clamp(0, l.dailyMinor);
            return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
              GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Today', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: ZxSpace.xs),
                Text('Used ${formatMinor(l.usedTodayMinor)} of ${formatMinor(l.dailyMinor)}'),
                const SizedBox(height: ZxSpace.sm),
                LinearProgressIndicator(value: l.dailyMinor == 0 ? 0 : (l.usedTodayMinor / l.dailyMinor).clamp(0, 1), minHeight: 8, borderRadius: BorderRadius.circular(4)),
                const SizedBox(height: ZxSpace.xs),
                Text('${formatMinor(left)} left. Each payment is also capped at ${formatMinor(l.perTransferMinor)}.', style: const TextStyle(fontSize: 12)),
              ])),
              const SizedBox(height: ZxSpace.md),
              GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Your daily limit', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: ZxSpace.sm),
                TextField(controller: _c, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Daily limit (LKR)', prefixText: 'LKR ')),
                if (_error != null) ZxErrorText(_error!),
                const SizedBox(height: ZxSpace.md),
                ZxButton(label: _busy ? 'Saving…' : 'Save limit', onPressed: _busy ? null : () => _save(l)),
                const SizedBox(height: ZxSpace.xs),
                Text('You can set any limit up to the bank maximum of ${formatMinor(l.bankMaximumMinor)}. Raising your limit asks for your PIN; lowering it does not.', style: const TextStyle(fontSize: 12)),
              ])),
            ]);
          },
        ),
      );
}
