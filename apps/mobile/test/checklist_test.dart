import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/accounts/presentation/accounts_pages.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/authentication/presentation/auth_pages.dart';
import 'package:zentrix_bank/features/payments/presentation/payment_flow.dart';
import 'package:zentrix_bank/features/security_center/security_pages.dart';
import 'package:zentrix_bank/features/services/presentation/savings_pages.dart';
import 'package:zentrix_bank/features/settings/settings_controller.dart';
import 'package:zentrix_bank/features/support/presentation/history_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

class _YesBio implements BiometricService {
  @override
  Future<bool> available() async => true;
  @override
  Future<bool> authenticate(String reason) async => true;
}

Map<String, dynamic>? _base(String p) {
  if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
  if (p == '/api/v1/transactions') return {'items': [], 'nextCursor': null};
  return null;
}

void main() {
  testWidgets('registration: five steps, nothing is sent until the last one, then the profile and identity are sent together', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => {});
    await t.pumpWidget(pageHarness(api, const RegisterPage()));
    await t.pumpAndSettle();
    expect(find.text('Step 1 of 5: Personal'), findsOneWidget);

    await t.enterText(find.widgetWithText(TextFormField, 'Full name'), 'Amaya Perera');
    await t.tap(find.widgetWithText(TextFormField, 'Date of birth'));
    await t.pumpAndSettle();
    await t.tap(find.text('OK'));
    await t.pumpAndSettle();
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();

    expect(find.text('Step 2 of 5: Contact'), findsOneWidget);
    await t.tap(find.text('Continue')); // empty: stays here and says what is missing
    await t.pumpAndSettle();
    expect(find.text('Enter a valid email'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'Email'), 'amaya@example.test');
    await t.enterText(find.widgetWithText(TextFormField, 'Address'), '12 Temple Rd');
    await t.enterText(find.widgetWithText(TextFormField, 'City'), 'Kandy');
    await t.enterText(find.widgetWithText(TextFormField, 'Postal code'), '20000');
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();

    expect(find.text('Step 3 of 5: Sign-in'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'Username'), 'amaya.p');
    await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'Str0ngPassw0rd!x');
    await t.enterText(find.widgetWithText(TextFormField, 'Confirm password'), 'different');
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();
    expect(find.text('Passwords do not match'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'Confirm password'), 'Str0ngPassw0rd!x');
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();

    expect(find.text('Step 4 of 5: Identity'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextFormField, 'National ID number'), '199512345678');
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();
    expect(find.text('Please confirm the details match your national ID.'), findsOneWidget);
    await t.tap(find.byType(CheckboxListTile));
    await t.tap(find.text('Continue'));
    await t.pumpAndSettle();

    expect(find.text('Step 5 of 5: Review'), findsOneWidget);
    expect(find.text('Amaya Perera'), findsOneWidget);
    expect(find.text('amaya.p'), findsOneWidget);
    expect(api.requests.where((r) => r.method == 'CALL'), isEmpty); // still nothing sent
    await t.tap(find.text('Create account'));
    await t.pumpAndSettle();

    final calls = api.requests.where((r) => r.method == 'CALL').toList();
    expect(calls.map((c) => c.path), ['register', 'submitKyc']);
    expect(calls[0].body!['username'], 'amaya.p');
    expect(calls[1].body!['nationalId'], '199512345678');
    expect(calls[1].body!['city'], 'Kandy');
  });

  testWidgets('forgot password: a 6-digit code is requested, then sent with the username and the new password', (t) async {
    final api = FakeApi((p, q, b) => {});
    await t.pumpWidget(pageHarness(api, const ForgotPasswordPage()));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Username or email'), 'amaya.p');
    await t.tap(find.text('Send verification code'));
    await t.pumpAndSettle();
    expect(find.textContaining('6-digit verification code'), findsOneWidget);
    expect(find.textContaining('Development only: your code is 123456'), findsOneWidget);
    await t.enterText(find.widgetWithText(TextField, 'Verification code'), '123456');
    await t.enterText(find.widgetWithText(TextField, 'New password'), 'Another-Str0ng-pass');
    await t.tap(find.text('Change password'));
    await t.pumpAndSettle();
    final c = api.requests.firstWhere((r) => r.path == 'confirmPasswordReset');
    expect(c.body, {'identifier': 'amaya.p', 'code': '123456'});
    expect(find.text('Password updated'), findsOneWidget);
  });

  testWidgets('security centre shows the most recent security alerts', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => p == '/api/v1/security/alerts' ? {'items': [{'id': 'n1', 'title': 'PIN changed', 'body': 'Your app PIN was changed.', 'at': '2026-03-01T10:00:00Z'}]} : {});
    await t.pumpWidget(pageHarness(api, const SecurityCenterPage()));
    await t.pumpAndSettle();
    expect(find.text('Recent security alerts'), findsOneWidget);
    expect(find.text('PIN changed'), findsOneWidget);
  });

  testWidgets('savings goal shows its target date and monthly auto-save, and auto-save can be stopped', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/savings/goals' && b == null) {
        return {'items': [{'id': 'g1', 'name': 'Trip', 'targetMinor': 5000000, 'savedMinor': 100000, 'progressPercent': 2, 'status': 'ACTIVE', 'targetDate': '2027-01-01T00:00:00Z', 'autoSave': {'monthlyMinor': 100000, 'accountId': 'a1', 'nextRunAt': '2026-12-01T00:00:00Z', 'lastFailure': 'Not enough money in the account'}}], 'totalSavedMinor': 100000};
      }
      return _base(p) ?? {};
    });
    await t.pumpWidget(pageHarness(api, const SavingsPage()));
    await t.pumpAndSettle();
    expect(find.textContaining('Target date 2027-01-01'), findsOneWidget);
    expect(find.textContaining('a month, next on 2026-12-01'), findsOneWidget);
    expect(find.textContaining('last attempt skipped: Not enough money'), findsOneWidget);
    await t.tap(find.text('Stop auto-save'));
    await t.pumpAndSettle();
    final put = api.where('PUT', '/api/v1/savings/goals/g1/auto').single;
    expect(put.body, {'monthlyAutoMinor': null});
  });

  testWidgets('budgets: suggested amounts come from the bank and can be applied with one tap', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/budgets') return {'items': [], 'categories': ['Food', 'Transport']};
      if (p == '/api/v1/analytics/budget-suggestions') return {'items': [{'category': 'Food', 'averageMinor': 800000, 'suggestedMinor': 850000}]};
      return {};
    });
    await t.pumpWidget(pageHarness(api, const BudgetsPage()));
    await t.pumpAndSettle();
    await t.tap(find.text('Suggest budgets'));
    await t.pumpAndSettle();
    expect(find.textContaining('not advice'), findsOneWidget);
    await t.tap(find.text('Use Food'));
    await t.pumpAndSettle();
    expect(api.where('PUT', '/api/v1/budgets/Food').single.body, {'limitMinor': 850000});
  });

  testWidgets('history: pending and failed payments are listed apart, and the type filter is sent to the bank', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/payments') {
        return q?['status'] == 'failed'
            ? {'items': [{'id': 'p2', 'status': 'FAILED', 'amountMinor': 5000, 'failureMessage': 'Insufficient funds', 'recipient': {'name': 'Nuwan', 'accountMasked': '***1', 'bank': 'Zentrix Bank'}}]}
            : {'items': []};
      }
      return _base(p) ?? {};
    });
    await t.pumpWidget(pageHarness(api, const HistoryPage()));
    await t.pumpAndSettle();
    expect(find.text('Pending and failed payments (1)'), findsOneWidget);
    await t.tap(find.text('Pending and failed payments (1)'));
    await t.pumpAndSettle();
    expect(find.text('Failed: Insufficient funds'), findsOneWidget);

    await t.tap(find.text('More filters'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String?>, 'Any type'));
    await t.pumpAndSettle();
    await t.tap(find.text('Bill payments').last);
    await t.pumpAndSettle();
    await t.tap(find.text('Apply'));
    await t.pumpAndSettle();
    expect(api.where('GET', '/api/v1/transactions').last.query!['kind'], 'BILL_PAYMENT');
  });

  testWidgets('the PIN sheet: a short PIN is refused on the spot, and biometrics release the stored PIN when the customer opted in', (t) async {
    final store = MemoryPrefsStore()..data.addAll({'biometricPay': '1', payPinKey: '482916'});
    String? got;
    await t.pumpWidget(ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(FakeApi((p, q, b) => {})), prefsStoreProvider.overrideWithValue(store), biometricServiceProvider.overrideWithValue(_YesBio())],
      child: Consumer(builder: (context, ref, _) => MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(body: Builder(builder: (ctx) => Column(children: [
          TextButton(onPressed: () => ref.read(settingsProvider.notifier).load(), child: const Text('load')),
          TextButton(onPressed: () async => got = await askPin(ctx), child: const Text('ask')),
        ]))),
      )),
    ));
    await t.tap(find.text('load'));
    await t.pumpAndSettle();
    await t.tap(find.text('ask'));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'App PIN'), '12');
    await t.tap(find.text('Confirm'));
    await t.pump();
    expect(find.text('Enter your 4 or 6 digit PIN'), findsOneWidget);
    expect(got, isNull);
    await t.tap(find.text('Use biometrics'));
    await t.pumpAndSettle();
    expect(got, '482916');
  });

  testWidgets('without the opt-in there is no biometric button in the PIN sheet', (t) async {
    await t.pumpWidget(ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(FakeApi((p, q, b) => {})), prefsStoreProvider.overrideWithValue(MemoryPrefsStore()), biometricServiceProvider.overrideWithValue(_YesBio())],
      child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: Builder(builder: (ctx) => TextButton(onPressed: () => askPin(ctx), child: const Text('ask'))))),
    ));
    await t.tap(find.text('ask'));
    await t.pumpAndSettle();
    expect(find.text('Use biometrics'), findsNothing);
  });

  testWidgets('opening an account can be paid for from another account, with the PIN', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/account-products') return {'items': [{'code': 'SAVINGS_STD', 'name': 'Savings Account', 'kind': 'SAVINGS', 'currency': 'LKR', 'minOpeningMinor': 100000, 'interestRateBps': 350}]};
      return _base(p) ?? {};
    });
    await t.pumpWidget(pageHarness(api, const OpenAccountPage()));
    await t.pumpAndSettle();
    await t.tap(find.text('Savings Account'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String?>, 'Opening deposit'));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Pay from Main savings').last);
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Deposit amount (LKR), at least LKR 1,000.00'), '2500.00');
    await t.tap(find.text('Submit application'));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'App PIN'), '482916');
    await t.tap(find.text('Confirm'));
    await t.pumpAndSettle();
    final body = api.where('POST', '/api/v1/account-applications').single.body!;
    expect(body['productCode'], 'SAVINGS_STD');
    expect(body['fundingAccountId'], 'a1');
    expect(body['fundingAmountMinor'], 250000);
    expect(body['pin'], '482916');
    expect(find.text('Application received'), findsOneWidget);
  });
}
