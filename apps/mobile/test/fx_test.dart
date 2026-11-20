import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/features/fx/fx_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

Map<String, dynamic> acctIn(String id, String name, int bal, String cur) => {...acct(id, name, bal), 'currency': cur, 'productName': '$cur Account'};

Map<String, dynamic> rates() => {
      'spreadBps': 150, 'base': 'LKR', 'note': 'Indicative simulated rates set by the bank.',
      'items': [
        {'currency': 'USD', 'midRate': 320, 'youPayPerUnit': 324.8, 'youGetPerUnit': 315.2, 'updatedAt': null},
        {'currency': 'EUR', 'midRate': 350, 'youPayPerUnit': 355.25, 'youGetPerUnit': 344.75, 'updatedAt': null},
      ],
    };

Map<String, dynamic> quote({int expiresInSeconds = 60}) => {
      'fromAccountId': 'a1', 'toAccountId': 'a2', 'fromCurrency': 'LKR', 'toCurrency': 'USD', 'fromAmountMinor': 3248000, 'toAmountMinor': 10000, 'rate': 324.8, 'rateText': '1 USD = LKR 324.80',
      'token': 'tok.sig-abcdefghijklmnop', 'expiresAt': DateTime.now().add(Duration(seconds: expiresInSeconds)).toUtc().toIso8601String(),
    };

Future<void> enterPin(WidgetTester t, {String pin = '482916'}) async {
  await t.enterText(find.widgetWithText(TextField, 'App PIN'), pin);
  await t.tap(find.text('Confirm'));
  await t.pumpAndSettle();
}

FakeApi apiWith({bool foreign = true, void Function()? onExchange, Map<String, dynamic> Function()? quoteJson}) => FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') {
        return {'items': [acctIn('a1', 'Main savings', 5000000, 'LKR'), if (foreign) acctIn('a2', 'Travel dollars', 0, 'USD')], 'totalBalanceMinor': 5000000};
      }
      if (p == '/api/v1/fx/rates') return rates();
      if (p == '/api/v1/fx/quote') return (quoteJson ?? quote)();
      if (p == '/api/v1/fx/exchange') { onExchange?.call(); return {'replayed': false, 'reference': 'FX1', 'fromAmountMinor': 3248000, 'toAmountMinor': 10000, 'fromCurrency': 'LKR', 'toCurrency': 'USD'}; }
      return {};
    });

void main() {
  testWidgets('shows today\'s rates and, with no foreign account, points to opening one', (t) async {
    tallScreen(t);
    await t.pumpWidget(pageHarness(apiWith(foreign: false), const ExchangePage(), stubs: {'/accounts/open': 'open page'}));
    await t.pumpAndSettle();
    expect(find.text('Buy 324.80  ·  Sell 315.20'), findsOneWidget);
    expect(find.textContaining('Open a foreign-currency account'), findsOneWidget);
    await t.tap(find.text('Open an account'));
    await t.pumpAndSettle();
    expect(find.text('open page'), findsOneWidget);
  });

  testWidgets('get a quote -> see the exact amount and rate -> confirm with the PIN -> done; only valid pairs are offered', (t) async {
    tallScreen(t);
    var exchanged = 0;
    final api = apiWith(onExchange: () => exchanged++);
    await t.pumpWidget(pageHarness(api, const ExchangePage()));
    await t.pumpAndSettle();

    await t.tap(find.text('Get quote'));
    await t.pumpAndSettle();
    expect(find.text('Enter the amount you want to exchange.'), findsOneWidget); // amount is checked first
    expect(api.where('GET', '/api/v1/fx/quote'), isEmpty);

    await t.tap(find.widgetWithText(DropdownButtonFormField<String>, 'From'));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Main savings').last);
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String>, 'To'));
    await t.pumpAndSettle();
    expect(find.textContaining('Main savings · LKR'), findsOneWidget); // only the other currency is offered as the destination
    await t.tap(find.textContaining('Travel dollars').last);
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Amount to exchange (LKR)'), '32480');
    await t.tap(find.text('Get quote'));
    await t.pumpAndSettle();
    final qr = api.where('GET', '/api/v1/fx/quote').single.query!;
    expect(qr, {'fromAccountId': 'a1', 'toAccountId': 'a2', 'amountMinor': 3248000});
    expect(find.text('LKR 32,480.00 → USD 100.00'), findsOneWidget);
    expect(find.text('Rate: 1 USD = LKR 324.80'), findsOneWidget);
    expect(find.textContaining('Valid for'), findsOneWidget);

    await t.tap(find.text('Confirm exchange'));
    await t.pumpAndSettle();
    await enterPin(t);
    expect(api.where('POST', '/api/v1/fx/exchange').single.body, {'token': 'tok.sig-abcdefghijklmnop', 'pin': '482916'});
    expect(exchanged, 1);
    expect(find.text('Exchange complete'), findsOneWidget);
    expect(find.text('You exchanged LKR 32,480.00 for USD 100.00.'), findsOneWidget);
  });

  testWidgets('an expired quote cannot be confirmed', (t) async {
    tallScreen(t);
    final api = apiWith(quoteJson: () => quote(expiresInSeconds: 0));
    await t.pumpWidget(pageHarness(api, const ExchangePage()));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String>, 'From'));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Main savings').last);
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(DropdownButtonFormField<String>, 'To'));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Travel dollars').last);
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField, 'Amount to exchange (LKR)'), '32480');
    await t.tap(find.text('Get quote'));
    await t.pumpAndSettle();
    expect(find.textContaining('This quote has expired'), findsOneWidget);
    final confirm = t.widget<FilledButton>(find.ancestor(of: find.text('Confirm exchange'), matching: find.byType(FilledButton)));
    expect(confirm.onPressed, isNull);
    expect(api.where('POST', '/api/v1/fx/exchange'), isEmpty);
  });
}
