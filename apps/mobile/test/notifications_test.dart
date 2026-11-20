import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/core/network/resilience.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/payments/data/payments_repository.dart';
import 'package:zentrix_bank/features/payments/presentation/payment_flow.dart';
import 'package:zentrix_bank/features/payments/presentation/payments_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

Map<String, dynamic> note(String id, String cat, String title, {bool read = false}) => {'id': id, 'category': cat, 'title': title, 'body': 'Body of $title', 'read': read, 'createdAt': '2026-03-01T10:00:00Z'};

class _Offline implements OnlineService {
  @override
  Future<bool> current() async => false;
  @override
  Stream<bool> changes() => const Stream.empty();
}

void main() {
  testWidgets('notifications can be filtered by category, and tapping an unread one marks it read', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/notifications') return {'unread': 2, 'items': [note('n1', 'TRANSACTION', 'Payment sent'), note('n2', 'SECURITY', 'New device added'), note('n3', 'CARD', 'Card approved', read: true)]};
      return {};
    });
    await t.pumpWidget(pageHarness(api, const NotificationsPage()));
    await t.pumpAndSettle();
    expect(find.text('Payment sent'), findsOneWidget);
    expect(find.text('New device added'), findsOneWidget);

    await t.tap(find.widgetWithText(ChoiceChip, 'Security'));
    await t.pumpAndSettle();
    expect(find.text('New device added'), findsOneWidget);
    expect(find.text('Payment sent'), findsNothing);
    await t.tap(find.widgetWithText(ChoiceChip, 'Loans'));
    await t.pumpAndSettle();
    expect(find.text('Nothing in this category.'), findsOneWidget);

    await t.tap(find.widgetWithText(ChoiceChip, 'All'));
    await t.pumpAndSettle();
    await t.tap(find.text('Payment sent'));
    await t.pumpAndSettle();
    expect(api.where('POST', '/api/v1/notifications/n1/read'), hasLength(1));
    await t.tap(find.text('Card approved')); // already read: nothing to send
    await t.pumpAndSettle();
    expect(api.where('POST', '/api/v1/notifications/n3/read'), isEmpty);
  });

  testWidgets('while offline a payment cannot be authorized, and the screen says why', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
      if (p == '/api/v1/payments' && b != null) {
        return {
          'id': 'p1', 'reference': 'ZX20261119ABCD2345', 'kind': 'INTERNAL_TRANSFER', 'status': 'AWAITING_AUTHORIZATION', 'amountMinor': 250000, 'feeMinor': 0, 'totalMinor': 250000, 'currency': 'LKR', 'sourceAccountId': 'a1',
          'recipient': {'name': 'Nuwan Silva', 'accountMasked': '*******9876', 'bank': 'Zentrix Bank'}, 'note': null, 'scheduledFor': null, 'createdAt': '2026-03-01T10:00:00Z', 'postedAt': null, 'failureCode': null, 'failureMessage': null,
        };
      }
      return {};
    });
    final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => PaymentReviewPage(draft: DraftRequest(sourceAccountId: 'a1', destination: {'type': 'ZENTRIX', 'accountNumber': '10000000009'}, amountMinor: 250000)))]);
    await t.pumpWidget(ProviderScope(overrides: [authRepositoryProvider.overrideWithValue(api), onlineServiceProvider.overrideWithValue(_Offline())], child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router)));
    await t.pumpAndSettle();
    expect(find.textContaining('You are offline. Reconnect to authorize'), findsOneWidget);
    final btn = t.widget<FilledButton>(find.ancestor(of: find.text('Authorize payment'), matching: find.byType(FilledButton)));
    expect(btn.onPressed, isNull);
  });
}
