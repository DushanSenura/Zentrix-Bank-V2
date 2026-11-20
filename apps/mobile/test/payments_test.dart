import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/core/utils/money.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

import 'fake_api.dart';

Map<String, dynamic> payment(String status, {int amount = 250000, int fee = 0, String? failure, String id = 'p1'}) => {
      'id': id, 'reference': 'ZX20261119ABCD2345', 'kind': 'INTERNAL_TRANSFER', 'status': status, 'amountMinor': amount, 'feeMinor': fee, 'totalMinor': amount + fee,
      'currency': 'LKR', 'sourceAccountId': 'a1', 'recipient': {'name': 'Nuwan Silva', 'accountMasked': '*******9876', 'bank': 'Zentrix Bank'}, 'note': null,
      'scheduledFor': null, 'createdAt': '2026-03-01T10:00:00Z', 'postedAt': status == 'POSTED' ? '2026-03-01T10:00:05Z' : null,
      'failureCode': failure, 'failureMessage': failure == null ? null : 'Insufficient funds',
    };

/// Base routes every test needs: accounts + notifications badge.
Map<String, dynamic>? base(String p) {
  if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
  if (p == '/api/v1/notifications') return {'unread': 0, 'items': []};
  if (p == '/api/v1/me/preferences') return {'defaultAccountId': null, 'notifications': {}, 'alwaysOn': ['SECURITY']};
  if (p == '/api/v1/transactions') return {'items': [], 'nextCursor': null}; // the home screen's recent-transactions list
  return null;
}

Future<void> openTransferAndReview(WidgetTester t, FakeApi api, {String amount = '2500.00'}) async {
  await t.pumpWidget(appWith(api));
  await t.pumpAndSettle();
  await t.tap(find.text('Send money'));
  await t.pumpAndSettle();
  await t.enterText(find.widgetWithText(TextFormField, 'Zentrix account number'), '10000000009');
  await t.enterText(find.widgetWithText(TextFormField, 'Amount (LKR)'), amount);
  await t.tap(find.text('Review'));
  await t.pumpAndSettle();
}

Future<void> authorizeWithPin(WidgetTester t, {String pin = '482916'}) async {
  await t.tap(find.text('Authorize payment'));
  await t.pumpAndSettle();
  await t.enterText(find.widgetWithText(TextField, 'App PIN'), pin);
  await t.tap(find.text('Confirm'));
  await t.pumpAndSettle();
}

void main() {
  test('parseMajorToMinor parses typed amounts without floating point and rejects bad input', () {
    expect(parseMajorToMinor('2500'), 250000);
    expect(parseMajorToMinor('2,500.50'), 250050);
    expect(parseMajorToMinor('0.5'), 50);
    expect(parseMajorToMinor('19.99'), 1999);
    for (final bad in ['', '0', '0.00', '-5', '1.234', 'abc', '1e5', '12.', '.5']) {
      expect(parseMajorToMinor(bad), isNull, reason: bad);
    }
  });

  testWidgets('happy path: review shows the bank\'s figures, PIN authorises, receipt comes from the bank', (t) async {
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return payment('AWAITING_AUTHORIZATION');
      if (p == '/api/v1/payments/p1/authorize') return payment('POSTED');
      throw ApiFailure('not_found', p);
    });
    await openTransferAndReview(t, api);

    final create = api.where('POST', '/api/v1/payments').single;
    expect(create.body, {'sourceAccountId': 'a1', 'destination': {'type': 'ZENTRIX', 'accountNumber': '10000000009'}, 'amountMinor': 250000});
    expect(create.body!.containsKey('feeMinor'), isFalse); // the app never sends a fee/balance/status
    expect(create.headers!['Idempotency-Key'], matches(RegExp(r'^[0-9a-f]{32}$')));
    expect(find.text('Review payment'), findsOneWidget);
    expect(find.text('LKR 2,500.00'), findsWidgets);
    expect(find.textContaining('Nuwan Silva'), findsOneWidget); // resolved by the bank, not typed by the user
    expect(find.text('No fee'), findsOneWidget);
    expect(api.where('POST', '/api/v1/payments/p1/authorize'), isEmpty); // nothing happens before the PIN

    await authorizeWithPin(t);
    expect(api.where('POST', '/api/v1/payments/p1/authorize').single.body, {'pin': '482916'});
    expect(find.text('Payment successful'), findsOneWidget);
    expect(find.text('ZX20261119ABCD2345'), findsOneWidget);
  });

  testWidgets('fees and totals are shown exactly as the bank returns them (the app computes nothing)', (t) async {
    final api = FakeApi((p, q, b) => base(p) ?? payment('AWAITING_AUTHORIZATION', fee: 2500));
    await openTransferAndReview(t, api);
    expect(find.text('LKR 25.00'), findsOneWidget);
    expect(find.text('LKR 2,525.00'), findsOneWidget);
  });

  testWidgets('wrong PIN: the bank refuses, the customer stays on review with a clear message and can retry', (t) async {
    var attempts = 0;
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return payment('AWAITING_AUTHORIZATION');
      attempts++;
      if (b!['pin'] != '482916') throw ApiFailure('invalid_pin', 'Incorrect PIN');
      return payment('POSTED');
    });
    await openTransferAndReview(t, api);
    await authorizeWithPin(t, pin: '000000');
    expect(find.text('Incorrect PIN'), findsOneWidget);
    expect(find.text('Payment failed'), findsNothing);
    expect(find.text('Review payment'), findsOneWidget);
    await authorizeWithPin(t);
    expect(attempts, 2);
    expect(find.text('Payment successful'), findsOneWidget);
  });

  testWidgets('Scenario J: a dropped connection during authorisation is an UNKNOWN outcome, reconciled with the bank, never "failed" and never re-sent', (t) async {
    var polled = 0;
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return payment('AWAITING_AUTHORIZATION');
      if (p == '/api/v1/payments/p1/authorize') throw ApiFailure('network', 'Cannot reach Zentrix Bank. Check your connection and try again.', network: true);
      if (p == '/api/v1/payments/p1') { polled++; return payment('POSTED'); } // the payment actually went through
      throw ApiFailure('not_found', p);
    });
    await openTransferAndReview(t, api);
    await authorizeWithPin(t);
    expect(find.text('We could not confirm this payment'), findsOneWidget);
    expect(find.textContaining('Do not pay twice'), findsOneWidget);
    expect(find.text('Payment failed'), findsNothing);
    expect(find.text('Payment successful'), findsNothing);
    expect(find.text('Authorize payment'), findsNothing); // cannot blindly pay again
    expect(api.where('POST', '/api/v1/payments/p1/authorize'), hasLength(1)); // no automatic duplicate send

    await t.tap(find.text('Check status'));
    await t.pumpAndSettle();
    expect(polled, 1);
    expect(find.text('Payment successful'), findsOneWidget);
    expect(api.where('POST', '/api/v1/payments/p1/authorize'), hasLength(1));
  });

  testWidgets('unknown outcome where the bank never saw the authorisation: says nothing was sent and allows a retry', (t) async {
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return payment('AWAITING_AUTHORIZATION');
      if (p == '/api/v1/payments/p1/authorize') throw ApiFailure('network', 'offline', network: true);
      return payment('AWAITING_AUTHORIZATION'); // GET: still only a draft
    });
    await openTransferAndReview(t, api);
    await authorizeWithPin(t);
    await t.tap(find.text('Check status'));
    await t.pumpAndSettle();
    expect(find.textContaining('nothing was sent'), findsOneWidget);
    expect(find.text('Authorize payment'), findsOneWidget);
  });

  testWidgets('a connection failure while creating the draft retries with the SAME Idempotency-Key', (t) async {
    var fail = true;
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (fail) { fail = false; throw ApiFailure('network', 'offline', network: true); }
      return payment('AWAITING_AUTHORIZATION');
    });
    await openTransferAndReview(t, api);
    expect(find.text('Cannot reach the bank'), findsOneWidget);
    await t.tap(find.text('Try again'));
    await t.pumpAndSettle();
    final keys = api.where('POST', '/api/v1/payments').map((r) => r.headers!['Idempotency-Key']).toList();
    expect(keys, hasLength(2));
    expect(keys[0], keys[1]); // the bank dedupes; a lost response can never create two payments
    expect(find.text('Review payment'), findsOneWidget);
    expect(find.text('Authorize payment'), findsOneWidget);
  });

  testWidgets('a bank refusal at draft time (e.g. insufficient funds) is shown plainly', (t) async {
    final api = FakeApi((p, q, b) => base(p) ?? (throw ApiFailure('insufficient_funds', 'Insufficient funds for this payment and its fee')));
    await openTransferAndReview(t, api);
    expect(find.text('Payment not sent'), findsOneWidget);
    expect(find.text('Insufficient funds for this payment and its fee'), findsOneWidget);
  });

  testWidgets('a payment the bank reports FAILED shows failure and that no money was taken', (t) async {
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return payment('AWAITING_AUTHORIZATION');
      return payment('FAILED', failure: 'INSUFFICIENT_FUNDS');
    });
    await openTransferAndReview(t, api);
    await authorizeWithPin(t);
    expect(find.text('Payment failed'), findsOneWidget);
    expect(find.textContaining('No money was taken'), findsOneWidget);
  });

  testWidgets('the transfer form validates amounts and account numbers before anything is sent', (t) async {
    final api = FakeApi((p, q, b) => base(p) ?? payment('AWAITING_AUTHORIZATION'));
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    await t.tap(find.text('Send money'));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextFormField, 'Zentrix account number'), '123');
    await t.enterText(find.widgetWithText(TextFormField, 'Amount (LKR)'), '12.345');
    await t.tap(find.text('Review'));
    await t.pumpAndSettle();
    expect(find.text('Enter the 11-digit account number'), findsOneWidget);
    expect(find.text('Enter an amount like 2500.00'), findsOneWidget);
    expect(api.where('POST', '/api/v1/payments'), isEmpty);
  });

  testWidgets('recipients: list, favourite toggle and confirmed delete call the bank', (t) async {
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/beneficiaries') {
        return {'items': [{'id': 'b1', 'bankCode': 'ZENTRIX', 'bankName': 'Zentrix Bank', 'accountNumberMasked': '*******9876', 'holderName': 'Nuwan Silva', 'nickname': 'Nuwan', 'favorite': false}]};
      }
      return {};
    });
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(OutlinedButton, 'Payments')); // the home button, not the nav bar label
    await t.pumpAndSettle();
    await t.tap(find.text('Recipients'));
    await t.pumpAndSettle();
    expect(find.text('Nuwan'), findsOneWidget);
    await t.tap(find.byTooltip('Make favourite'));
    await t.pumpAndSettle();
    expect(api.where('PUT', '/api/v1/beneficiaries/b1').single.body, {'favorite': true});
    await t.tap(find.byTooltip('Delete recipient'));
    await t.pumpAndSettle();
    expect(api.where('DELETE', '/api/v1/beneficiaries/b1'), isEmpty); // confirmation first
    await t.tap(find.text('Remove'));
    await t.pumpAndSettle();
    expect(api.where('DELETE', '/api/v1/beneficiaries/b1'), hasLength(1));
  });

  testWidgets('scheduled payments: upcoming and repeating are listed and cancellable', (t) async {
    final api = FakeApi((p, q, b) {
      final x = base(p);
      if (x != null) return x;
      if (p == '/api/v1/payments') return {'items': [{...payment('AUTHORIZED'), 'scheduledFor': '2026-04-01T03:30:00Z'}]};
      if (p == '/api/v1/scheduled-payments') {
        return {'items': [{'id': 's1', 'recipient': {'name': 'Landlord', 'accountMasked': '*******1111', 'bank': 'Zentrix Bank'}, 'amountMinor': 100000, 'currency': 'LKR', 'frequency': 'MONTHLY', 'nextRunAt': '2026-05-01T03:30:00Z', 'lastFailure': 'Insufficient funds'}]};
      }
      return payment('CANCELLED');
    });
    await t.pumpWidget(appWith(api));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(OutlinedButton, 'Payments')); // the home button, not the nav bar label
    await t.pumpAndSettle();
    await t.tap(find.text('Scheduled & repeating'));
    await t.pumpAndSettle();
    expect(find.textContaining('to Nuwan Silva'), findsOneWidget);
    expect(find.textContaining('Every month'), findsOneWidget);
    expect(find.textContaining('Last run failed'), findsOneWidget);
    await t.tap(find.text('Stop'));
    await t.pumpAndSettle();
    expect(api.where('DELETE', '/api/v1/scheduled-payments/s1'), hasLength(1));
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(api.where('POST', '/api/v1/payments/p1/cancel'), hasLength(1));
  });
}
