import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/features/profile/profile_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

Map<String, dynamic> profileJson({String email = 'amaya@example.test', String? phone}) => {
      'fullName': 'Amaya Perera', 'customerNumber': 'ZB90000001', 'username': 'amaya.demo', 'email': email, 'phone': phone, 'kycStatus': 'APPROVED', 'memberSince': '2026-01-01T00:00:00Z',
      'dateOfBirth': '1995-04-12', 'address': {'line1': '12 Temple Rd', 'city': 'Kandy', 'postalCode': '20000'}, 'nationalIdMasked': '••••••••', 'canEdit': ['email', 'phone'],
    };

Future<void> enterPin(WidgetTester t, {String pin = '482916'}) async {
  await t.enterText(find.widgetWithText(TextField, 'App PIN'), pin);
  await t.tap(find.text('Confirm'));
  await t.pumpAndSettle();
}

Map<String, dynamic> prefs({String? def, bool tx = true}) => {'defaultAccountId': def, 'notifications': {'TRANSACTION': tx, 'ACCOUNT': true, 'CARD': true, 'LOAN': true, 'DEPOSIT': true, 'BUDGET': true}, 'alwaysOn': ['SECURITY']};
Map<String, dynamic> limits({int daily = 5000000, int used = 120000}) => {'dailyMinor': daily, 'bankMaximumMinor': 5000000, 'perTransferMinor': 5000000, 'usedTodayMinor': used, 'customised': daily < 5000000};

void main() {
  group('personal details', () {
    testWidgets('shows verified details as read-only and sends only the changed contact field with the PIN', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => p == '/api/v1/me/profile' ? profileJson() : {});
      await t.pumpWidget(pageHarness(api, const EditProfilePage()));
      await t.pumpAndSettle();
      expect(find.text('Amaya Perera'), findsOneWidget);
      expect(find.text('12 Temple Rd, Kandy, 20000'), findsOneWidget);
      expect(find.text('••••••••'), findsOneWidget); // national ID stays masked
      expect(find.textContaining('contact the bank'), findsOneWidget);

      await t.enterText(find.widgetWithText(TextField, 'Mobile number'), '+94 77 123 4567');
      await t.tap(find.text('Save changes'));
      await t.pumpAndSettle();
      await enterPin(t);
      final sent = api.where('PATCH', '/api/v1/me/profile').single.body!;
      expect(sent, {'phone': '+94 77 123 4567', 'pin': '482916'}); // email unchanged -> not sent
    });

    testWidgets('validates before asking for a PIN, and says so when nothing changed', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => p == '/api/v1/me/profile' ? profileJson() : {});
      await t.pumpWidget(pageHarness(api, const EditProfilePage()));
      await t.pumpAndSettle();
      await t.tap(find.text('Save changes'));
      await t.pumpAndSettle();
      expect(find.text('Nothing has changed.'), findsOneWidget);
      await t.enterText(find.widgetWithText(TextField, 'Email'), 'not-an-email');
      await t.tap(find.text('Save changes'));
      await t.pumpAndSettle();
      expect(find.text('Enter a valid email address.'), findsOneWidget);
      expect(api.where('PATCH', '/api/v1/me/profile'), isEmpty);
    });
  });

  group('settings', () {
    Map<String, dynamic> handler(String p) {
      if (p == '/api/v1/me/preferences') return prefs();
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000), acct('a2', 'Bills', 100000)], 'totalBalanceMinor': 5100000};
      return {};
    }

    testWidgets('notification categories are saved on the server, and security alerts are shown as always on', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => handler(p));
      await t.pumpWidget(pageHarness(api, const SettingsPage()));
      await t.pumpAndSettle();
      await t.scrollUntilVisible(find.text('Security alerts'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('Always on for your protection'), findsOneWidget);
      await t.tap(find.widgetWithText(SwitchListTile, 'Payments and transfers'));
      await t.pumpAndSettle();
      expect(api.where('PUT', '/api/v1/me/preferences').single.body, {'notifications': {'TRANSACTION': false}});
    });

    testWidgets('default account is chosen from the active accounts and saved on the server', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => handler(p));
      await t.pumpWidget(pageHarness(api, const SettingsPage()));
      await t.pumpAndSettle();
      await t.scrollUntilVisible(find.text('Default account'), 200, scrollable: find.byType(Scrollable).first);
      await t.tap(find.text('Default account'));
      await t.pumpAndSettle();
      await t.tap(find.text('Bills'));
      await t.pumpAndSettle();
      expect(api.where('PUT', '/api/v1/me/preferences').single.body, {'defaultAccountId': 'a2'});
    });
  });

  group('transfer limits', () {
    testWidgets('lowering needs no PIN; raising asks for it; above the bank maximum is refused on the device', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => p == '/api/v1/security/limits' ? limits(daily: 3000000) : {});
      await t.pumpWidget(pageHarness(api, const LimitsPage()));
      await t.pumpAndSettle();
      expect(find.textContaining('Used LKR 1,200.00 of LKR 30,000.00'), findsOneWidget);

      await t.enterText(find.widgetWithText(TextField, 'Daily limit (LKR)'), '20000');
      await t.tap(find.text('Save limit'));
      await t.pumpAndSettle();
      expect(api.where('PUT', '/api/v1/security/limits').last.body, {'dailyMinor': 2000000}); // lowering: no PIN at all

      await t.enterText(find.widgetWithText(TextField, 'Daily limit (LKR)'), '60000');
      await t.tap(find.text('Save limit'));
      await t.pumpAndSettle();
      expect(find.textContaining('The bank maximum is'), findsOneWidget);
      expect(api.where('PUT', '/api/v1/security/limits'), hasLength(1));

      await t.enterText(find.widgetWithText(TextField, 'Daily limit (LKR)'), '40000');
      await t.tap(find.text('Save limit'));
      await t.pumpAndSettle();
      await enterPin(t);
      expect(api.where('PUT', '/api/v1/security/limits').last.body, {'dailyMinor': 4000000, 'pin': '482916'});
    });
  });

  group('profile', () {
    testWidgets('shows the account links', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => p == '/api/v1/notifications' ? {'unread': 3, 'items': []} : {});
      await t.pumpWidget(pageHarness(api, const ProfilePage()));
      await t.pumpAndSettle();
      for (final s in ['Personal details', 'Notifications', 'Security centre', 'Settings', 'Help and support', 'Sign out']) {
        expect(find.text(s), findsOneWidget, reason: s);
      }
    });
  });
}
