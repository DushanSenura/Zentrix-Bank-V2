import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../data/auth_repository.dart';
import 'auth_controller.dart';
import 'auth_pages.dart';

String? _required(String? v) => (v == null || v.trim().isEmpty) ? 'Required' : null;

// ───────────────────────── Identity verification (KYC) ─────────────────────────
/// Submits identity details for STAFF review. Nothing is verified here: the bank decides, and the app only
/// reflects the status the server reports. (Document image upload arrives with the object-storage phase.)
class KycPage extends ConsumerStatefulWidget {
  const KycPage({super.key});
  @override
  ConsumerState<KycPage> createState() => _KycPageState();
}

class _KycPageState extends ConsumerState<KycPage> with FormRunner {
  final _form = GlobalKey<FormState>();
  final _nid = TextEditingController(), _dob = TextEditingController(), _l1 = TextEditingController(), _city = TextEditingController(), _zip = TextEditingController();

  @override
  void dispose() { for (final c in [_nid, _dob, _l1, _city, _zip]) { c.dispose(); } super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(title: 'Verify your identity', back: true, children: [
      Form(
        key: _form,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextFormField(controller: _nid, decoration: InputDecoration(labelText: 'National ID number', errorText: fieldErrors['nationalId']), validator: (v) => RegExp(r'^[A-Za-z0-9]{5,20}$').hasMatch(v ?? '') ? null : 'Enter a valid ID number'),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _dob, decoration: InputDecoration(labelText: 'Date of birth (YYYY-MM-DD)', errorText: fieldErrors['dateOfBirth']), keyboardType: TextInputType.datetime, validator: (v) => RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(v ?? '') ? null : 'Use YYYY-MM-DD'),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _l1, decoration: const InputDecoration(labelText: 'Address'), validator: _required),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _city, decoration: const InputDecoration(labelText: 'City'), validator: _required),
          const SizedBox(height: ZxSpace.md),
          TextFormField(controller: _zip, decoration: const InputDecoration(labelText: 'Postal code'), validator: _required),
          const SizedBox(height: ZxSpace.md),
          ZxErrorText(error),
          ZxButton(label: 'Submit for review', loading: busy, onPressed: () {
            if (!_form.currentState!.validate()) return;
            final router = GoRouter.of(context);
            run(() async {
              await ref.read(authRepositoryProvider).submitKyc(nationalId: _nid.text.trim(), dateOfBirth: _dob.text.trim(), line1: _l1.text.trim(), city: _city.text.trim(), postalCode: _zip.text.trim());
              await ref.read(authControllerProvider.notifier).refreshMe();
              router.go('/');
            });
          }),
        ]),
      ),
    ]);
  }
}

// ───────────────────────── PIN setup ─────────────────────────
class PinSetupPage extends ConsumerStatefulWidget {
  const PinSetupPage({super.key});
  @override
  ConsumerState<PinSetupPage> createState() => _PinSetupPageState();
}

class _PinSetupPageState extends ConsumerState<PinSetupPage> with FormRunner {
  final _pin = TextEditingController(), _confirm = TextEditingController();

  @override
  void dispose() { _pin.dispose(); _confirm.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(title: 'Set your app PIN', back: true, children: [
      const Text('Choose a 4 or 6 digit PIN. It is stored only as a salted hash on the bank\'s server.', textAlign: TextAlign.center),
      const SizedBox(height: ZxSpace.md),
      TextField(controller: _pin, obscureText: true, keyboardType: TextInputType.number, maxLength: 6, decoration: InputDecoration(labelText: 'PIN', errorText: fieldErrors['pin'])),
      TextField(controller: _confirm, obscureText: true, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'Confirm PIN')),
      const SizedBox(height: ZxSpace.sm),
      ZxErrorText(error),
      ZxButton(label: 'Save PIN', loading: busy, onPressed: () {
        if (_pin.text != _confirm.text) { setState(() => error = 'PINs do not match'); return; }
        final router = GoRouter.of(context);
        run(() async {
          await ref.read(authRepositoryProvider).setPin(_pin.text);
          await ref.read(authControllerProvider.notifier).refreshMe();
          router.go('/');
        });
      }),
    ]);
  }
}

// ───────────────────────── Home (status) ─────────────────────────
/// Phase 2 landing page: shows only what the server says about the customer. Banking screens arrive in Phase 3.
class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // On sign-out this rebuilds once with no user before the router redirects to /login.
    final me = ref.watch(authControllerProvider).me;
    if (me == null) return const SizedBox.shrink();
    final (String text, String? action, String? route) = switch (me.kycStatus) {
      'NOT_SUBMITTED' => ('Verify your identity so the bank can activate your account.', 'Verify identity', '/kyc'),
      'MORE_INFO_REQUESTED' => ('The bank needs more information: ${me.kycNote ?? ''}', 'Update details', '/kyc'),
      'SUBMITTED' => ('Your details are with the bank for review. We will notify you of the decision.', null, null),
      'REJECTED' => ('Your verification was not approved: ${me.kycNote ?? 'please contact support.'}', null, null),
      _ => ('Your account is verified and active. Banking features arrive in the next release.', null, null),
    };
    return AuthScaffold(title: 'Hello, ${me.fullName.split(' ').first}', children: [
      if (me.customerNumber != null) Text('Customer ID ${me.customerNumber}', textAlign: TextAlign.center),
      const SizedBox(height: ZxSpace.md),
      Text(text, textAlign: TextAlign.center),
      const SizedBox(height: ZxSpace.md),
      if (action != null) ZxButton(label: action, onPressed: () => context.push(route!)),
      if (!me.hasPin) ...[const SizedBox(height: ZxSpace.sm), ZxButton(label: 'Set app PIN', onPressed: () => context.push('/pin'))],
      TextButton(onPressed: () => context.push('/security'), child: const Text('Security & settings')),
      TextButton(onPressed: () => ref.read(authControllerProvider.notifier).logout(), child: const Text('Sign out')),
    ]);
  }
}
