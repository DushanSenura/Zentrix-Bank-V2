import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_api.dart';

Map<String, dynamic> txn(String id, String desc, int amount) => {
      'id': id, 'accountId': 'a1', 'accountLabel': 'Main savings', 'reference': 'R$id', 'kind': 'TRANSFER', 'description': desc, 'amountMinor': amount, 'currency': 'LKR', 'status': 'POSTED', 'postedAt': DateTime.now().toUtc().toIso8601String(), 'paymentId': null,
    };

FakeApi homeApi() => FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
      if (p == '/api/v1/notifications') return {'unread': 0, 'items': []};
      if (p == '/api/v1/transactions') return {'items': [txn('t1', 'Salary', 250000), txn('t2', 'Groceries', -125050), txn('t3', 'Water bill', -4000)], 'nextCursor': null};
      if (p == '/api/v1/profile' || p == '/api/v1/me/profile') return {'fullName': 'Amaya Perera', 'customerNumber': 'ZB90000001', 'username': 'amaya.demo', 'email': 'a@example.test', 'phone': null, 'kycStatus': 'APPROVED', 'memberSince': '2026-01-01T00:00:00Z', 'dateOfBirth': null, 'address': null, 'nationalIdMasked': null, 'canEdit': ['email', 'phone']};
      return {'items': []};
    });

void main() {
  testWidgets('home shows quick actions, the five-tab bar and the latest transactions', (t) async {
    final api = homeApi();
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    for (final label in ['Transfer', 'Pay bills', 'Scan', 'More']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    for (final label in ['Home', 'Payments', 'Cards', 'History', 'Profile']) {
      expect(find.widgetWithText(NavigationDestination, label), findsOneWidget, reason: label);
    }
    await t.scrollUntilVisible(find.text('Recent transactions'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Groceries'), findsOneWidget);
    expect(find.text('-LKR 1,250.50'), findsOneWidget);
    expect(find.text('View all'), findsOneWidget);
  });

  testWidgets('balances hidden also hides the amounts in recent transactions', (t) async {
    final api = homeApi();
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Hide balances'));
    await t.pumpAndSettle();
    await t.scrollUntilVisible(find.text('Recent transactions'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('-LKR 1,250.50'), findsNothing);
  });

  testWidgets('the bar moves between tabs, and each tab highlights itself', (t) async {
    final api = homeApi();
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(NavigationDestination, 'History'));
    await t.pumpAndSettle();
    expect(find.text('Transaction history'), findsOneWidget);
    expect(t.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex, 3);
    await t.tap(find.widgetWithText(NavigationDestination, 'Profile'));
    await t.pumpAndSettle();
    expect(find.text('Personal details'), findsOneWidget);
    expect(t.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex, 4);
    await t.tap(find.widgetWithText(NavigationDestination, 'Home'));
    await t.pumpAndSettle();
    expect(find.textContaining('Total balance'), findsOneWidget);
  });
}
