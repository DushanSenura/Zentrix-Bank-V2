import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/features/insights/presentation/insights_pages.dart';
import 'package:zentrix_bank/features/services/presentation/loan_calculator_page.dart';

import 'fake_api.dart';
import 'harness.dart';

Map<String, dynamic> product(String code, String name, int rateBps) => {'code': code, 'name': name, 'minAmountMinor': 10000000, 'maxAmountMinor': 500000000, 'minTermMonths': 6, 'maxTermMonths': 60, 'rateBps': rateBps, 'description': 'x'};

void main() {
  testWidgets('loan calculator asks the bank for the estimate, labels it as not an offer, and links to applying', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/loan-products') return {'items': [product('PERSONAL', 'Personal loan', 1450), product('EDU', 'Education loan', 950)]};
      if (p == '/api/v1/loans/calculate') return {'emiMinor': 2450000, 'totalInterestMinor': 1900000, 'totalPayableMinor': 11900000, 'eligibility': {'band': 'COMFORTABLE', 'disclaimer': 'An estimate only, not an offer.'}};
      return {};
    });
    await t.pumpWidget(pageHarness(api, const LoanCalculatorPage(), stubs: {'/services/loans/apply': 'apply page'}));
    await t.pumpAndSettle();
    expect(find.textContaining('Personal loan'), findsWidgets);
    expect(find.text('Estimated instalment'), findsNothing); // nothing until asked
    await t.tap(find.text('Calculate'));
    await t.pumpAndSettle();
    final q = api.where('GET', '/api/v1/loans/calculate').single.query!;
    expect(q['productCode'], 'PERSONAL');
    expect(q['amountMinor'], 10000000); // starts at the product minimum
    expect(q['termMonths'], 6);
    expect(q.containsKey('monthlyIncomeMinor'), isFalse);
    expect(find.text('LKR 24,500.00 a month'), findsOneWidget);
    expect(find.text('An estimate only, not an offer.'), findsOneWidget);
    expect(find.text('Affordability: comfortable'), findsOneWidget);

    await t.enterText(find.widgetWithText(TextField, 'Monthly income (optional, LKR)'), '150000');
    await t.tap(find.text('Calculate'));
    await t.pumpAndSettle();
    expect(api.where('GET', '/api/v1/loans/calculate').last.query!['monthlyIncomeMinor'], 15000000);

    await t.tap(find.text('Apply for a loan'));
    await t.pumpAndSettle();
    expect(find.text('apply page'), findsOneWidget);
  });

  testWidgets('insights charts describe themselves for screen readers and repeat every figure as text', (t) async {
    tallScreen(t);
    final handle = t.ensureSemantics();
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/analytics/summary') {
        return {
          'month': '2026-03', 'previousMonth': '2026-02', 'moneyInMinor': 700000, 'spentMinor': 125050, 'netMinor': 574950, 'previous': {'moneyInMinor': 0, 'spentMinor': 0}, 'spentChangePercent': null,
          'categories': [{'category': 'Transfers', 'spentMinor': 100000, 'sharePercent': 80, 'previousMinor': 0, 'changePercent': null}, {'category': 'Electricity', 'spentMinor': 25050, 'sharePercent': 20, 'previousMinor': 0, 'changePercent': null}],
          'largestPayments': [], 'budgets': [],
        };
      }
      if (p == '/api/v1/analytics/trend') return {'items': [{'month': '2026-02', 'spentMinor': 0, 'moneyInMinor': 300000}, {'month': '2026-03', 'spentMinor': 125050, 'moneyInMinor': 700000}]};
      if (p == '/api/v1/analytics/recurring') return {'items': []};
      if (p == '/api/v1/ai/insights') return {'month': '2026-03', 'narrative': null, 'narrativeIsAiGenerated': false, 'disclaimer': 'x', 'items': []};
      return {};
    });
    await t.pumpWidget(pageHarness(api, const InsightsPage()));
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp(r'Donut chart: Transfers 80 percent, Electricity 20 percent')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'Cash flow chart\..*Mar 2026: in LKR 7,000.00, spent LKR 1,250.50')), findsOneWidget);
    expect(find.text('Spending split'), findsOneWidget);
    expect(find.text('Cash flow'), findsOneWidget);
    expect(find.text('80%'), findsWidgets);
    handle.dispose();
  });
}
