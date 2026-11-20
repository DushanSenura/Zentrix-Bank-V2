import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/insights/presentation/insights_pages.dart';
import 'package:zentrix_bank/features/fx/fx_pages.dart';
import 'package:zentrix_bank/features/payments/presentation/payments_pages.dart' show NotificationsPage;
import 'package:zentrix_bank/features/profile/profile_pages.dart';
import 'package:zentrix_bank/features/profile/two_factor_page.dart';
import 'package:zentrix_bank/features/search/search_page.dart';
import 'package:zentrix_bank/features/services/presentation/loan_calculator_page.dart';
import 'package:zentrix_bank/features/support/presentation/support_pages.dart';

import 'fake_api.dart';

FakeApi api() => FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
      if (p == '/api/v1/transactions') {
        return {'items': [{'id': 't1', 'accountId': 'a1', 'accountLabel': 'Main savings', 'reference': 'R1', 'kind': 'TRANSFER', 'description': 'Salary', 'amountMinor': 250000, 'currency': 'LKR', 'status': 'POSTED', 'postedAt': '2026-03-05T10:00:00Z', 'paymentId': 'p1'}], 'nextCursor': null};
      }
      if (p == '/api/v1/analytics/summary') {
        return {'month': '2026-03', 'previousMonth': '2026-02', 'moneyInMinor': 700000, 'spentMinor': 125050, 'netMinor': 574950, 'previous': {'moneyInMinor': 0, 'spentMinor': 100000}, 'spentChangePercent': 25, 'categories': [{'category': 'Transfers', 'spentMinor': 100000, 'sharePercent': 80, 'previousMinor': 0, 'changePercent': null}], 'largestPayments': [], 'budgets': []};
      }
      if (p == '/api/v1/analytics/trend') return {'items': [{'month': '2026-03', 'spentMinor': 125050, 'moneyInMinor': 0}, {'month': '2026-02', 'spentMinor': 100000, 'moneyInMinor': 0}]};
      if (p == '/api/v1/ai/insights') return {'month': '2026-03', 'narrative': null, 'narrativeIsAiGenerated': false, 'disclaimer': 'Not financial advice.', 'items': [{'kind': 'FACT', 'title': 'You spent LKR 1,250.50', 'detail': 'Detail'}]};
      if (p == '/api/v1/support/faqs') return {'items': [{'q': 'What if a payment looks wrong?', 'a': 'Report it.'}]};
      if (p == '/api/v1/me/profile') return {'fullName': 'Amaya Perera', 'customerNumber': 'ZB90000001', 'username': 'amaya.demo', 'email': 'a@example.test', 'phone': null, 'kycStatus': 'APPROVED', 'memberSince': '2026-01-01T00:00:00Z', 'dateOfBirth': '1995-04-12', 'address': {'line1': '12 Temple Rd', 'city': 'Kandy', 'postalCode': '20000'}, 'nationalIdMasked': '••••••••', 'canEdit': ['email', 'phone']};
      if (p == '/api/v1/me/preferences') return {'defaultAccountId': null, 'notifications': {'TRANSACTION': true, 'ACCOUNT': true, 'CARD': true, 'LOAN': true, 'DEPOSIT': true, 'BUDGET': true}, 'alwaysOn': ['SECURITY']};
      if (p == '/api/v1/security/limits') return {'dailyMinor': 3000000, 'bankMaximumMinor': 5000000, 'perTransferMinor': 5000000, 'usedTodayMinor': 120000, 'customised': true};
      if (p == '/api/v1/security/2fa') return {'enabled': false, 'recoveryCodesLeft': 0};
      if (p == '/api/v1/fx/rates') return {'note': 'Indicative.', 'items': [{'currency': 'USD', 'midRate': 320, 'youPayPerUnit': 324.8, 'youGetPerUnit': 315.2}]};
      if (p == '/api/v1/loan-products') return {'items': [{'code': 'PERSONAL', 'name': 'Personal loan', 'minAmountMinor': 10000000, 'maxAmountMinor': 500000000, 'minTermMonths': 6, 'maxTermMonths': 60, 'rateBps': 1450, 'description': 'x'}]};
      if (p == '/api/v1/notifications') return {'unread': 1, 'items': [{'id': 'n1', 'category': 'TRANSACTION', 'title': 'Payment sent', 'body': 'LKR 100.00 sent', 'read': false, 'createdAt': '2026-03-01T10:00:00Z'}]};
      if (p == '/api/v1/transactions/t1') return {'id': 't1', 'reference': 'R1', 'kind': 'TRANSFER', 'description': 'Groceries', 'status': 'POSTED', 'amountMinor': -125050, 'currency': 'LKR', 'postedAt': '2026-03-05T10:00:00Z', 'account': {'id': 'a1', 'label': 'Main savings', 'numberMasked': '*******1234'}, 'category': 'Transfers', 'counterparty': {'name': 'Kamal', 'bank': 'Zentrix Bank', 'accountMasked': '*******4321'}, 'note': null, 'feeMinor': 0, 'paymentId': 'p1', 'canRepeat': true, 'canReport': true};
      return {'items': []};
    });

Widget host(Widget page, {Brightness brightness = Brightness.light, double scale = 1}) {
  final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => page)]);
  return ProviderScope(
    overrides: [authRepositoryProvider.overrideWithValue(api()), prefsStoreProvider.overrideWithValue(MemoryPrefsStore())],
    child: MaterialApp.router(
      theme: buildTheme(brightness),
      routerConfig: router,
      builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)), child: child!),
    ),
  );
}

final pages = <String, Widget Function()>{
  'transaction history': () => const HistoryPage(),
  'statements': () => const StatementsPage(),
  'help and support': () => const SupportHubPage(),
  'report a problem': () => const ReportProblemPage(paymentId: 'p1'),
  'new request': () => const NewTicketPage(),
  'spending insights': () => const InsightsPage(),
  'help assistant': () => const AssistantPage(),
  'profile': () => const ProfilePage(),
  'personal details': () => const EditProfilePage(),
  'settings': () => const SettingsPage(),
  'transfer limits': () => const LimitsPage(),
  'two-step sign-in': () => const TwoFactorPage(),
  'search': () => const SearchPage(),
  'currency exchange': () => const ExchangePage(),
  'loan calculator': () => const LoanCalculatorPage(),
  'notifications': () => const NotificationsPage(),
  'transaction details': () => const TransactionDetailsPage(id: 't1'),
  'branches': () => const BranchesPage(),
};

void main() {
  for (final theme in [Brightness.light, Brightness.dark]) {
    group('accessibility (${theme.name} theme)', () {
      for (final e in pages.entries) {
        testWidgets('${e.key}: tap targets are large enough and every tappable control has a label', (t) async {
          final handle = t.ensureSemantics();
          await t.pumpWidget(host(e.value(), brightness: theme));
          await t.pumpAndSettle();
          await expectLater(t, meetsGuideline(androidTapTargetGuideline));
          await expectLater(t, meetsGuideline(labeledTapTargetGuideline));
          handle.dispose();
        });
      }
    });
  }

  group('accessibility (contrast and large text)', () {
    for (final e in pages.entries) {
      testWidgets('${e.key}: meets text contrast in light theme', (t) async {
        final handle = t.ensureSemantics();
        await t.pumpWidget(host(e.value()));
        await t.pumpAndSettle();
        await expectLater(t, meetsGuideline(textContrastGuideline));
        handle.dispose();
      });

      testWidgets('${e.key}: stays usable at 2x text size (no overflow errors)', (t) async {
        t.view.physicalSize = const Size(390 * 3, 844 * 3);
        t.view.devicePixelRatio = 3;
        addTearDown(t.view.reset);
        await t.pumpWidget(host(e.value(), scale: 2));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull); // a RenderFlex overflow would be reported here
      });
    }
  });

  testWidgets('reduce motion: charts appear at their final size immediately', (t) async {
    await t.pumpWidget(ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(api())],
      child: MaterialApp.router(
        theme: buildTheme(Brightness.light),
        routerConfig: GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => const InsightsPage())]),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: true), child: child!),
      ),
    ));
    await t.pump(); // one frame to load
    await t.pump(const Duration(milliseconds: 10));
    final bars = t.widgetList<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).where((b) => b.value != null).toList();
    expect(bars, isNotEmpty);
    expect(bars.any((b) => (b.value ?? 0) >= 0.79), isTrue); // the 80% bar is already full-length, not mid-animation
  });
}
