import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/core/utils/money.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

typedef Handler = Map<String, dynamic> Function(String path, Map<String, dynamic>? query, Map<String, dynamic>? body);

class FakeApi implements AuthRepository {
  FakeApi(this.handler);
  final Handler handler;
  final calls = <String>[];
  static const active = Me(id: '1', fullName: 'Amaya Perera', status: 'ACTIVE', kycStatus: 'APPROVED', hasPin: false, customerNumber: 'ZB90000001');

  @override
  Future<Me?> restore() async => active;
  @override
  Future<Map<String, dynamic>> getJson(String path, {Map<String, dynamic>? query}) async { calls.add('GET $path'); return handler(path, query, null); }
  @override
  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body) async { calls.add('POST $path'); return handler(path, null, body); }
  @override
  Future<void> logout() async {}
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

class NoBio implements BiometricService {
  @override
  Future<bool> available() async => false;
  @override
  Future<bool> authenticate(String reason) async => false;
}

Map<String, dynamic> acct(String id, String name, int bal, {String status = 'ACTIVE'}) => {
      'id': id, 'accountNumberMasked': '*******1234', 'nickname': name, 'productName': 'Savings Account', 'productCode': 'SAVINGS_STD', 'kind': 'SAVINGS',
      'interestRateBps': 350, 'currency': 'LKR', 'status': status, 'openedAt': '2026-01-01T00:00:00Z', 'balanceMinor': bal,
    };

Widget app(FakeApi api) => ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(api),
        prefsStoreProvider.overrideWithValue(MemoryPrefsStore()..data['onboarded'] = '1'),
        biometricServiceProvider.overrideWithValue(NoBio()),
      ],
      child: const ZentrixApp(),
    );

void main() {
  test('formatMinor formats integer minor units without floating point', () {
    expect(formatMinor(250050), 'LKR 2,500.50');
    expect(formatMinor(5), 'LKR 0.05');
    expect(formatMinor(100000000), 'LKR 1,000,000.00');
    expect(formatMinor(-1999), '-LKR 19.99');
    expect(formatMinor(1999, signed: true), '+LKR 19.99');
  });

  testWidgets('dashboard shows the server-reported total and accounts; balances can be hidden', (t) async {
    final api = FakeApi((p, q, b) => {'items': [acct('a1', 'Main savings', 5000000), acct('a2', 'Rainy day', 250050)], 'totalBalanceMinor': 5250050});
    await t.pumpWidget(app(api));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
    expect(find.text('LKR 52,500.50'), findsOneWidget); // total
    expect(find.text('LKR 50,000.00'), findsOneWidget);
    expect(find.text('Main savings'), findsOneWidget);

    await t.tap(find.byTooltip('Hide balances'));
    await t.pumpAndSettle();
    expect(find.text('LKR 52,500.50'), findsNothing);
    expect(find.text(hiddenAmount), findsWidgets);
  });

  testWidgets('empty state offers to open an account', (t) async {
    await t.pumpWidget(app(FakeApi((p, q, b) => {'items': [], 'totalBalanceMinor': 0})));
    await t.pumpAndSettle();
    expect(find.textContaining('no accounts yet'), findsOneWidget);
    expect(find.text('Open an account'), findsOneWidget);
  });

  testWidgets('a failed load shows a real error with retry, and retry recovers', (t) async {
    var fail = true;
    final api = FakeApi((p, q, b) {
      if (fail) throw ApiFailure('network', 'Cannot reach Zentrix Bank. Check your connection and try again.', network: true);
      return {'items': [acct('a1', 'Main savings', 100)], 'totalBalanceMinor': 100};
    });
    await t.pumpWidget(app(api));
    await t.pumpAndSettle();
    expect(find.textContaining('Cannot reach Zentrix Bank'), findsOneWidget);
    fail = false;
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    expect(find.text('Main savings'), findsOneWidget);
  });

  testWidgets('account detail shows ledger history with signed amounts and loads more with the cursor', (t) async {
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 90000)], 'totalBalanceMinor': 90000};
      if (p == '/api/v1/accounts/a1') return acct('a1', 'Main savings', 90000);
      if (p == '/api/v1/accounts/a1/transactions') {
        return q?['cursor'] == null
            ? {'items': [{'id': 't2', 'reference': 'R2', 'kind': 'TRANSFER', 'description': 'Rent', 'amountMinor': -10000, 'postedAt': '2026-03-02T10:00:00Z'}], 'nextCursor': 'c1'}
            : {'items': [{'id': 't1', 'reference': 'R1', 'kind': 'ACCOUNT_OPENING', 'description': 'Opening deposit', 'amountMinor': 100000, 'postedAt': '2026-03-01T10:00:00Z'}], 'nextCursor': null};
      }
      throw ApiFailure('not_found', 'nope');
    });
    await t.pumpWidget(app(api));
    await t.pumpAndSettle();
    await t.tap(find.text('Main savings'));
    await t.pumpAndSettle();
    expect(find.text('Recent activity'), findsOneWidget);
    expect(find.text('Rent'), findsOneWidget);
    expect(find.text('-LKR 100.00'), findsOneWidget);
    expect(find.text('Opening deposit'), findsNothing);
    await t.ensureVisible(find.text('Load more'));
    await t.tap(find.text('Load more'));
    await t.pumpAndSettle();
    expect(find.text('Opening deposit'), findsOneWidget);
    expect(find.text('+LKR 1,000.00'), findsOneWidget);
    expect(find.text('Load more'), findsNothing); // no more pages
  });

  testWidgets('a frozen account explains its status', (t) async {
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main', 100, status: 'FROZEN')], 'totalBalanceMinor': 100};
      if (p == '/api/v1/accounts/a1') return acct('a1', 'Main', 100, status: 'FROZEN');
      return {'items': [], 'nextCursor': null};
    });
    await t.pumpWidget(app(api));
    await t.pumpAndSettle();
    expect(find.text('Frozen'), findsOneWidget);
    await t.tap(find.text('Main'));
    await t.pumpAndSettle();
    expect(find.textContaining('money can come in'), findsOneWidget);
    expect(find.text('No transactions yet.'), findsOneWidget);
  });

  testWidgets('opening an account submits the chosen product and tracks the application', (t) async {
    Map<String, dynamic>? sent;
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [], 'totalBalanceMinor': 0};
      if (p == '/api/v1/account-products') {
        return {'items': [{'code': 'SAVINGS_STD', 'name': 'Savings Account', 'kind': 'SAVINGS', 'currency': 'LKR', 'minOpeningMinor': 100000, 'interestRateBps': 350}]};
      }
      if (p == '/api/v1/account-applications' && b != null) { sent = b; return {'id': 'x', 'status': 'SUBMITTED'}; }
      if (p == '/api/v1/account-applications') {
        return {'items': [{'id': 'x', 'productName': 'Savings Account', 'status': 'SUBMITTED', 'createdAt': '2026-03-01T10:00:00Z', 'decisionReason': null, 'accountId': null}]};
      }
      return {};
    });
    await t.pumpWidget(app(api));
    await t.pumpAndSettle();
    await t.tap(find.text('Open an account'));
    await t.pumpAndSettle();
    expect(find.textContaining('Minimum opening deposit LKR 1,000.00'), findsOneWidget);
    await t.tap(find.text('Savings Account'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'Holiday');
    await t.tap(find.text('Submit application'));
    await t.pumpAndSettle();
    expect(sent, {'productCode': 'SAVINGS_STD', 'nickname': 'Holiday'});
    expect(find.text('Application received'), findsOneWidget);
    await t.tap(find.text('Track applications'));
    await t.pumpAndSettle();
    expect(find.text('Received'), findsOneWidget);
  });
}
