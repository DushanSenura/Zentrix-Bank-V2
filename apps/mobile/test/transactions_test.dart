import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/payments/data/payments_repository.dart';
import 'package:zentrix_bank/features/support/presentation/history_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

Map<String, dynamic> txn(String id, String desc, int amount, DateTime at, {String? paymentId}) => {
      'id': id, 'accountId': 'a1', 'accountLabel': 'Main savings', 'reference': 'R$id', 'kind': 'TRANSFER', 'description': desc, 'amountMinor': amount, 'currency': 'LKR', 'status': 'POSTED', 'postedAt': at.toUtc().toIso8601String(), 'paymentId': paymentId,
    };

Map<String, dynamic> detail({bool canRepeat = true}) => {
      'id': 't2', 'reference': 'RT2', 'kind': 'TRANSFER', 'description': 'Groceries', 'status': 'POSTED', 'amountMinor': -125050, 'currency': 'LKR', 'postedAt': '2026-03-05T10:00:00Z',
      'account': {'id': 'a1', 'label': 'Main savings', 'numberMasked': '*******1234'}, 'category': 'Transfers', 'counterparty': {'name': 'Kamal Fernando', 'bank': 'Zentrix Bank', 'accountMasked': '*******4321'},
      'note': 'weekly shop', 'feeMinor': 0, 'paymentId': 'p1', 'canRepeat': canRepeat, 'canReport': true,
    };

void main() {
  testWidgets('groups by day with Today and Yesterday headings, and opens a transaction', (t) async {
    tallScreen(t);
    final now = DateTime.now();
    final api = FakeApi((p, q, b) => p == '/api/v1/transactions' ? {'items': [txn('t1', 'Salary', 250000, now), txn('t2', 'Groceries', -125050, now.subtract(const Duration(days: 1)), paymentId: 'p1')], 'nextCursor': null} : {'items': []});
    await t.pumpWidget(pageHarness(api, const HistoryPage(), stubs: {'/transactions/:id': 'details page'}));
    await t.pumpAndSettle();
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Yesterday'), findsOneWidget);
    await t.tap(find.text('Groceries'));
    await t.pumpAndSettle();
    expect(find.text('details page'), findsOneWidget);
  });

  testWidgets('advanced filters (category, amounts) go to the server, show as removable chips, and bad amounts are refused', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => p == '/api/v1/transactions' ? {'items': [], 'nextCursor': null} : {'items': []});
    await t.pumpWidget(pageHarness(api, const HistoryPage()));
    await t.pumpAndSettle();
    await t.tap(find.text('More filters'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String?>, 'Any category'));
    await t.pumpAndSettle();
    await t.tap(find.text('Electricity').last);
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Smallest amount (LKR)'), '5000');
    await t.enterText(find.widgetWithText(TextField, 'Largest amount (LKR)'), '100');
    await t.tap(find.text('Apply'));
    await t.pumpAndSettle();
    expect(find.text('The smallest amount must not be more than the largest.'), findsOneWidget);

    await t.enterText(find.widgetWithText(TextField, 'Largest amount (LKR)'), '9000.50');
    await t.tap(find.text('Apply'));
    await t.pumpAndSettle();
    final q = api.where('GET', '/api/v1/transactions').last.query!;
    expect(q['category'], 'Electricity');
    expect(q['minMinor'], 500000);
    expect(q['maxMinor'], 900050);
    expect(find.text('Electricity'), findsOneWidget); // chip
    expect(find.text('More filters (2)'), findsOneWidget);

    await t.tap(find.byTooltip('Delete').first); // remove the category chip
    await t.pumpAndSettle();
    expect(api.where('GET', '/api/v1/transactions').last.query!.containsKey('category'), isFalse);
  });

  testWidgets('details show the full picture and repeat opens a fresh draft for review (nothing is paid)', (t) async {
    tallScreen(t);
    DraftRequest? opened;
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/transactions/t2') return detail();
      if (p == '/api/v1/payments/p1/repeat') return {'sourceAccountId': 'a1', 'destination': {'type': 'ZENTRIX', 'accountNumber': '10000000002'}, 'amountMinor': 125050, 'note': 'weekly shop', 'recipientName': 'Kamal Fernando'};
      return {};
    });
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (_, _) => const TransactionDetailsPage(id: 't2')),
      GoRoute(path: '/payments/review', builder: (_, st) { opened = st.extra as DraftRequest; return const Scaffold(body: Text('review page')); }),
    ]);
    await t.pumpWidget(ProviderScope(overrides: [authRepositoryProvider.overrideWithValue(api)], child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router)));
    await t.pumpAndSettle();
    expect(find.text('-LKR 1,250.50'), findsOneWidget);
    expect(find.text('Kamal Fernando · Zentrix Bank · *******4321'), findsOneWidget);
    expect(find.text('weekly shop'), findsOneWidget);
    await t.tap(find.text('Repeat this payment'));
    await t.pumpAndSettle();
    expect(find.text('review page'), findsOneWidget);
    expect(opened!.destination, {'type': 'ZENTRIX', 'accountNumber': '10000000002'});
    expect(opened!.amountMinor, 125050);
    expect(api.where('POST', '/api/v1/payments'), isEmpty); // only a draft in the review flow; the server was not asked to pay
  });

  testWidgets('a transaction that cannot be repeated offers no repeat button', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => p == '/api/v1/transactions/t2' ? detail(canRepeat: false) : {});
    await t.pumpWidget(pageHarness(api, const TransactionDetailsPage(id: 't2')));
    await t.pumpAndSettle();
    expect(find.text('Repeat this payment'), findsNothing);
    expect(find.text('Report a problem'), findsOneWidget);
  });
}
