import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/insights/presentation/insights_pages.dart';
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
      return {'items': []};
    });

Widget host(Widget page, {Brightness brightness = Brightness.light, double scale = 1}) {
  final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => page)]);
  return ProviderScope(
    overrides: [authRepositoryProvider.overrideWithValue(api())],
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
