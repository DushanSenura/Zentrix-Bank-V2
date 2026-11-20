import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/profile/two_factor_page.dart';

import 'fake_api.dart';
import 'harness.dart';

class MfaRepo implements AuthRepository {
  final attempts = <Map<String, String?>>[];
  @override
  Future<Me?> restore() async => null;
  @override
  Future<Me> login(String identifier, String password, {bool remember = false, String? mfaCode, String? recoveryCode}) async {
    attempts.add({'mfa': mfaCode, 'recovery': recoveryCode});
    if (mfaCode == null && recoveryCode == null) throw ApiFailure('mfa_required', 'Enter your authenticator code');
    if (mfaCode == '000000') throw ApiFailure('invalid_credentials', 'Invalid credentials');
    return FakeApi.active;
  }
  @override
  Future<List<DemoAccount>> demoAccounts() async => const [];
  @override
  Future<void> logout() async {}
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

Widget app(AuthRepository repo) => ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(repo), prefsStoreProvider.overrideWithValue(MemoryPrefsStore()..data['onboarded'] = '1'), biometricServiceProvider.overrideWithValue(NoBio())],
      child: const ZentrixApp(),
    );

Future<void> enterPin(WidgetTester t, {String pin = '482916'}) async {
  await t.enterText(find.widgetWithText(TextField, 'App PIN'), pin);
  await t.tap(find.text('Confirm'));
  await t.pumpAndSettle();
}

void main() {
  group('sign-in with two-step', () {
    testWidgets('asks for the code only when the bank requires it, then signs in', (t) async {
      final repo = MfaRepo();
      await t.pumpWidget(app(repo));
      await t.pumpAndSettle();
      expect(find.text('Authenticator code'), findsNothing);
      await t.enterText(find.widgetWithText(TextFormField, 'Username, email or customer ID'), 'amaya.demo');
      await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'a-password');
      await t.tap(find.text('Sign in'));
      await t.pumpAndSettle();
      expect(find.text('Authenticator code'), findsOneWidget); // asked, not shown as an error
      expect(find.text('Enter your authenticator code'), findsNothing);

      await t.enterText(find.widgetWithText(TextFormField, 'Authenticator code'), '123456');
      await t.tap(find.text('Verify and sign in'));
      await t.pumpAndSettle();
      expect(repo.attempts.last, {'mfa': '123456', 'recovery': null});
      expect(find.text('Verify and sign in'), findsNothing); // signed in
    });

    testWidgets('a recovery code can be used instead, and a wrong code shows the bank\'s message', (t) async {
      final repo = MfaRepo();
      await t.pumpWidget(app(repo));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Username, email or customer ID'), 'amaya.demo');
      await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'a-password');
      await t.tap(find.text('Sign in'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Authenticator code'), '000000');
      await t.tap(find.text('Verify and sign in'));
      await t.pumpAndSettle();
      expect(find.text('Invalid credentials'), findsOneWidget);

      await t.tap(find.text('Use a recovery code'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Recovery code'), 'ABCDE-FGHJK');
      await t.tap(find.text('Verify and sign in'));
      await t.pumpAndSettle();
      expect(repo.attempts.last, {'mfa': null, 'recovery': 'ABCDE-FGHJK'});
    });
  });

  group('two-step page', () {
    testWidgets('turning on: PIN, scan or type the key, confirm a code, then the recovery codes are shown once', (t) async {
      tallScreen(t);
      var enabled = false;
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/security/2fa') return {'enabled': enabled, 'recoveryCodesLeft': enabled ? 8 : 0};
        if (p == '/api/v1/security/2fa/setup') return {'secret': 'JBSWY3DPEHPK3PXP', 'otpauthUri': 'otpauth://totp/Zentrix:amaya?secret=JBSWY3DPEHPK3PXP'};
        if (p == '/api/v1/security/2fa/enable') { enabled = true; return {'recoveryCodes': [for (var i = 0; i < 8; i++) 'AAAA$i-BBBB$i']}; }
        return {};
      });
      await t.pumpWidget(pageHarness(api, const TwoFactorPage()));
      await t.pumpAndSettle();
      expect(find.text('Two-step sign-in is off'), findsOneWidget);
      await t.tap(find.text('Turn on'));
      await t.pumpAndSettle();
      await enterPin(t);
      expect(api.where('POST', '/api/v1/security/2fa/setup').single.body, {'pin': '482916'});
      expect(find.text('JBSWY3DPEHPK3PXP'), findsOneWidget);

      await t.tap(find.text('Confirm and turn on'));
      await t.pumpAndSettle();
      expect(find.text('Enter the 6-digit code from your authenticator app.'), findsOneWidget);
      expect(api.where('POST', '/api/v1/security/2fa/enable'), isEmpty);

      await t.enterText(find.widgetWithText(TextField, 'Authenticator code'), '123456');
      await t.tap(find.text('Confirm and turn on'));
      await t.pumpAndSettle();
      expect(find.text('Save your recovery codes'), findsOneWidget);
      expect(find.text('AAAA0-BBBB0'), findsOneWidget);
      await t.tap(find.text('I have saved them'));
      await t.pumpAndSettle();
      expect(find.text('Two-step sign-in is on'), findsOneWidget);
      expect(find.textContaining('8 recovery codes left'), findsOneWidget);
      expect(find.text('AAAA0-BBBB0'), findsNothing); // never shown again
    });

    testWidgets('turning off needs the PIN and a code, sent together', (t) async {
      tallScreen(t);
      var enabled = true;
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/security/2fa') return {'enabled': enabled, 'recoveryCodesLeft': 5};
        if (p == '/api/v1/security/2fa/disable') { enabled = false; return {}; }
        return {};
      });
      await t.pumpWidget(pageHarness(api, const TwoFactorPage()));
      await t.pumpAndSettle();
      expect(find.textContaining('5 recovery codes left'), findsOneWidget);
      await t.tap(find.text('Turn off'));
      await t.pumpAndSettle();
      await enterPin(t);
      await t.enterText(find.widgetWithText(TextField, 'Authenticator code or recovery code'), '654321');
      await t.tap(find.text('Confirm'));
      await t.pumpAndSettle();
      expect(api.where('POST', '/api/v1/security/2fa/disable').single.body, {'pin': '482916', 'code': '654321'});
      expect(find.text('Two-step sign-in is off'), findsOneWidget);
    });
  });
}
