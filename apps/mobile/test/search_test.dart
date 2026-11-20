import 'package:flutter/material.dart' show TextField;
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/features/search/search_logic.dart';
import 'package:zentrix_bank/features/search/search_page.dart';

import 'fake_api.dart';
import 'harness.dart';

void main() {
  group('matcher', () {
    test('needs two characters and every word, ranking title matches first', () {
      expect(matchEntries('a'), isEmpty);
      expect(matchEntries('   '), isEmpty);
      expect(matchEntries('loan').first.title, 'Loans');
      expect(matchEntries('loan calculator').map((e) => e.title), ['Loan calculator']);
      expect(matchEntries('zzzzqq'), isEmpty);
    });

    test('finds features by their keywords and flags settings', () {
      expect(matchEntries('electricity').map((e) => e.route), contains('/payments/bills'));
      expect(matchEntries('daily limit').single.route, '/security/limits');
      expect(matchEntries('daily limit').single.isSetting, isTrue);
      expect(matchEntries('fingerprint').map((e) => e.route), contains('/security/preferences'));
    });

    test('every route points at something the app serves (no dead links)', () {
      for (final e in searchEntries) { expect(e.route.startsWith('/'), isTrue, reason: e.title); }
      expect(searchEntries.map((e) => e.route).toSet().length, searchEntries.length); // no duplicates
    });
  });

  group('page', () {
    testWidgets('shows device features at once and the bank results after a pause; remembers the search for the session', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/search') {
          return {
            'beneficiaries': [{'id': 'b1', 'bankCode': 'ZENTRIX', 'bankName': 'Zentrix Bank', 'accountNumberMasked': '*******4321', 'holderName': 'Kamal Fernando', 'nickname': 'Landlord', 'favorite': true}],
            'transactions': [{'id': 't1', 'accountLabel': 'Main savings', 'reference': 'R1', 'kind': 'TRANSFER', 'description': 'Rent March', 'amountMinor': -45000, 'postedAt': '2026-03-05T10:00:00Z', 'paymentId': 'p1'}],
          };
        }
        return {};
      });
      await t.pumpWidget(pageHarness(api, const SearchPage(), stubs: {'/payments/beneficiaries': 'recipients page', '/security/limits': 'limits page'}));
      await t.pumpAndSettle();
      expect(find.textContaining('Type at least two letters'), findsOneWidget);

      await t.enterText(find.byType(TextField), 'limit');
      await t.pump();
      expect(find.text('Transfer limits'), findsOneWidget); // matched on the device, no waiting
      expect(api.where('GET', '/api/v1/search'), isEmpty); // not yet: debounced
      await t.pump(const Duration(milliseconds: 400));
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/search').single.query, {'q': 'limit'});
      expect(find.text('Landlord'), findsOneWidget);
      expect(find.text('Rent March'), findsOneWidget);

      await t.tap(find.text('Transfer limits'));
      await t.pumpAndSettle();
      expect(find.text('limits page'), findsOneWidget);
    });

    testWidgets('says so when nothing matches, and refuses to search for one letter', (t) async {
      tallScreen(t);
      final api = FakeApi((p, q, b) => p == '/api/v1/search' ? {'beneficiaries': [], 'transactions': []} : {});
      await t.pumpWidget(pageHarness(api, const SearchPage()));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'q');
      await t.pump(const Duration(milliseconds: 500));
      expect(api.where('GET', '/api/v1/search'), isEmpty);
      await t.enterText(find.byType(TextField), 'zzzzqq');
      await t.pump(const Duration(milliseconds: 500));
      await t.pumpAndSettle();
      expect(find.text('Nothing matches. Try another word.'), findsOneWidget);
    });
  });
}
