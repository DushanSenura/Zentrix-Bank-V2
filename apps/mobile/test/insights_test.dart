import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/insights/presentation/insights_pages.dart';

import 'fake_api.dart';

Widget pageApp(FakeApi api, Widget page) {
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => page),
    GoRoute(path: '/support/tickets/new', builder: (_, _) => const Scaffold(body: Text('new ticket page'))),
    GoRoute(path: '/assistant', builder: (_, _) => const Scaffold(body: Text('assistant page'))),
  ]);
  return ProviderScope(overrides: [authRepositoryProvider.overrideWithValue(api)], child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router));
}

Map<String, dynamic> summary({int spent = 125050, int? change}) => {
      'month': '2026-03', 'previousMonth': '2026-02', 'currency': 'LKR', 'moneyInMinor': 700000, 'spentMinor': spent, 'netMinor': 700000 - spent,
      'previous': {'moneyInMinor': 0, 'spentMinor': change == null ? 0 : 100000}, 'spentChangePercent': change,
      'categories': spent == 0 ? [] : [
        {'category': 'Transfers', 'spentMinor': 100000, 'sharePercent': 80, 'previousMinor': 0, 'changePercent': null},
        {'category': 'Electricity', 'spentMinor': 25050, 'sharePercent': 20, 'previousMinor': 20000, 'changePercent': 25},
      ],
      'largestPayments': [], 'budgets': [],
    };

FakeApi insightsApi({Map<String, dynamic>? sum, String? narrative}) => FakeApi((p, q, b) {
      if (p == '/api/v1/analytics/summary') return sum ?? summary();
      if (p == '/api/v1/analytics/trend') {
        return {'items': [for (var i = 1; i <= 6; i++) {'month': '2026-0$i', 'spentMinor': i == 3 ? 125050 : 0, 'moneyInMinor': 0}]};
      }
      if (p == '/api/v1/analytics/recurring') {
        return {'items': [{'name': 'Lanka Mobile', 'amountMinor': 199000, 'frequency': 'MONTHLY', 'monthlyEquivalentMinor': 199000}], 'monthlyTotalMinor': 199000};
      }
      if (p == '/api/v1/ai/insights') {
        return {
          'month': '2026-03', 'narrative': narrative, 'narrativeIsAiGenerated': narrative != null, 'disclaimer': 'Estimates are projections, not facts, and this is not financial advice.',
          'items': [
            {'kind': 'FACT', 'title': 'You have spent LKR 1,250.50 this month', 'detail': 'First month with spending.'},
            {'kind': 'ESTIMATE', 'title': 'At this pace you may spend about LKR 3,000.00 by month end', 'detail': 'A straight-line projection.'},
          ],
        };
      }
      return {};
    });

void main() {
  group('spending insights', () {
    testWidgets('shows the bank\'s figures, categories and honest comparison wording', (t) async {
      await t.pumpWidget(pageApp(insightsApi(), const InsightsPage()));
      await t.pumpAndSettle();
      expect(find.text('Mar 2026'), findsOneWidget);
      expect(find.text('LKR 7,000.00'), findsOneWidget); // money in
      expect(find.text('Transfers'), findsNWidgets(2)); // the category list and the donut legend
      expect(find.text('LKR 1,000.00'), findsOneWidget);
      expect(find.text('+25% vs last month'), findsOneWidget);
      expect(find.text('No spending last month to compare with.'), findsOneWidget); // no invented percentage
      await t.scrollUntilVisible(find.text('Regular payments'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('Regular payments'), findsOneWidget);
      expect(find.text('Lanka Mobile (monthly)'), findsOneWidget);
    });

    testWidgets('labels facts and estimates separately, and shows no AI summary when AI is off', (t) async {
      await t.pumpWidget(pageApp(insightsApi(), const InsightsPage()));
      await t.pumpAndSettle();
      await t.scrollUntilVisible(find.text('What stands out'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('Fact'), findsOneWidget);
      expect(find.text('Estimate'), findsOneWidget);
      expect(find.text('AI-written summary'), findsNothing);
      expect(find.textContaining('not financial advice'), findsOneWidget);
    });

    testWidgets('an AI summary is clearly labelled as AI-written', (t) async {
      await t.pumpWidget(pageApp(insightsApi(narrative: 'You spent most on transfers.'), const InsightsPage()));
      await t.pumpAndSettle();
      await t.scrollUntilVisible(find.text('AI-written summary'), 300, scrollable: find.byType(Scrollable).first);
      expect(find.text('You spent most on transfers.'), findsOneWidget);
    });

    testWidgets('moving back a month asks the bank for that month; an empty month says so', (t) async {
      final api = insightsApi();
      await t.pumpWidget(pageApp(api, const InsightsPage()));
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Previous month'));
      await t.pumpAndSettle();
      final months = api.where('GET', '/api/v1/analytics/summary').map((r) => r.query?['month']).toList();
      expect(months.first, isNull);
      expect(months.last, matches(RegExp(r'^\d{4}-\d{2}$')));

      final empty = insightsApi(sum: summary(spent: 0));
      await t.pumpWidget(pageApp(empty, const InsightsPage()));
      await t.pumpAndSettle();
      expect(find.text('No spending this month.'), findsOneWidget);
    });

    testWidgets('a failure is explained with a retry', (t) async {
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/analytics/summary') throw ApiFailure('error', 'Something went wrong on our side. Please try again.');
        return {'items': []};
      });
      await t.pumpWidget(pageApp(api, const InsightsPage()));
      await t.pumpAndSettle();
      expect(find.text('Something went wrong on our side. Please try again.'), findsOneWidget);
    });
  });

  group('help assistant', () {
    testWidgets('shows the approved articles, never offers to act, and sends the data opt-in only when chosen', (t) async {
      final api = FakeApi((p, q, b) => {
            'answer': null, 'answerIsAiGenerated': false, 'matched': true, 'escalate': false, 'actionNotice': 'The assistant cannot make changes to your accounts.',
            'sources': [{'id': 'cards', 'title': 'Cards', 'text': 'You can freeze a card in the app.'}],
          });
      await t.pumpWidget(pageApp(api, const AssistantPage()));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Your question'), 'freeze my card');
      await t.tap(find.text('Ask'));
      await t.pumpAndSettle();
      expect(api.where('POST', '/api/v1/ai/ask').single.body, {'question': 'freeze my card', 'includeMyData': false});
      expect(find.text('The assistant cannot make changes to your accounts.'), findsOneWidget);
      expect(find.text('Cards'), findsOneWidget);
      expect(find.text('AI-written answer, based on the articles below'), findsNothing);
      expect(find.text('Message the bank'), findsNothing);

      await t.tap(find.byType(Switch));
      await t.tap(find.text('Ask'));
      await t.pumpAndSettle();
      expect(api.where('POST', '/api/v1/ai/ask').last.body!['includeMyData'], true);
    });

    testWidgets('labels AI-written answers, and offers a person when nothing matches', (t) async {
      var matched = true;
      final api = FakeApi((p, q, b) => matched
          ? {'answer': 'Freeze it from the card screen.', 'answerIsAiGenerated': true, 'matched': true, 'escalate': false, 'actionNotice': null, 'sources': [{'id': 'cards', 'title': 'Cards', 'text': 'x'}]}
          : {'answer': null, 'answerIsAiGenerated': false, 'matched': false, 'escalate': true, 'actionNotice': null, 'sources': []});
      await t.pumpWidget(pageApp(api, const AssistantPage()));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Your question'), 'freeze my card');
      await t.tap(find.text('Ask'));
      await t.pumpAndSettle();
      expect(find.text('AI-written answer, based on the articles below'), findsOneWidget);
      expect(find.text('Freeze it from the card screen.'), findsOneWidget);

      matched = false;
      await t.enterText(find.widgetWithText(TextField, 'Your question'), 'something unrelated');
      await t.tap(find.text('Ask'));
      await t.pumpAndSettle();
      expect(find.text('I could not find this in the help articles.'), findsOneWidget);
      await t.tap(find.text('Message the bank'));
      await t.pumpAndSettle();
      expect(find.text('new ticket page'), findsOneWidget);
    });

    testWidgets('a very short question is not sent', (t) async {
      final api = FakeApi((p, q, b) => {});
      await t.pumpWidget(pageApp(api, const AssistantPage()));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Your question'), 'hi');
      await t.tap(find.text('Ask'));
      await t.pumpAndSettle();
      expect(find.text('Ask a question in a few words.'), findsOneWidget);
      expect(api.where('POST', '/api/v1/ai/ask'), isEmpty);
    });
  });
}
