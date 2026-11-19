import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

import 'fake_api.dart';

Map<String, dynamic> card(String id, String status, {String kind = 'DEBIT', String? last4 = '4821'}) => {
      'id': id, 'kind': kind, 'network': 'VISA', 'status': status, 'statusText': {'ACTIVE': 'Active', 'FROZEN': 'Frozen', 'READY_TO_COLLECT': 'Ready to collect', 'PENDING_APPROVAL': 'Awaiting bank approval', 'BLOCKED': 'Blocked'}[status],
      'holderName': 'AMAYA PERERA', 'maskedNumber': last4 == null ? null : '•••• •••• •••• $last4', 'expiry': last4 == null ? null : '03/30', 'accountId': 'a1', 'readyOn': null, 'collectionBranch': status == 'READY_TO_COLLECT' ? 'Colombo Fort, Colombo' : null,
      'creditLimitMinor': null, 'decisionReason': null, 'createdAt': '2026-03-01T10:00:00Z',
      'controls': {'dailyLimitMinor': 10_000_000, 'maxDailyLimitMinor': 50_000_000, 'onlineEnabled': true, 'internationalEnabled': false, 'contactlessEnabled': true},
    };

Map<String, dynamic>? base(String p) {
  if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
  if (p == '/api/v1/notifications') return {'unread': 0, 'items': []};
  return null;
}

Future<void> open(WidgetTester t, FakeApi api, String tile) async {
  await t.pumpWidget(appWith(api));
  await t.pumpAndSettle();
  await t.ensureVisible(find.text('Cards, deposits, loans & savings'));
  await t.tap(find.text('Cards, deposits, loans & savings'));
  await t.pumpAndSettle();
  await t.tap(find.text(tile));
  await t.pumpAndSettle();
}

Future<void> enterPin(WidgetTester t, {String pin = '482916'}) async {
  await t.enterText(find.widgetWithText(TextField, 'App PIN'), pin);
  await t.tap(find.text('Confirm'));
  await t.pumpAndSettle();
}

void main() {
  group('cards', () {
    testWidgets('lists cards with the bank\'s status wording and never shows a full number', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? {'items': [card('c1', 'ACTIVE'), card('c2', 'PENDING_APPROVAL', kind: 'VIRTUAL', last4: null), card('c3', 'READY_TO_COLLECT')]});
      await open(t, api, 'Cards');
      expect(find.text('Active'), findsOneWidget);
      expect(find.text('Awaiting bank approval'), findsOneWidget);
      expect(find.text('Ready to collect'), findsOneWidget);
      expect(find.text('•••• •••• •••• 4821'), findsNWidgets(2));
      expect(find.text('Number issued after approval'), findsOneWidget);
    });

    testWidgets('freeze sends the request; tightening a limit needs no PIN but raising it does', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/cards' ? {'items': [card('c1', 'ACTIVE')]} : p == '/api/v1/cards/c1' ? card('c1', 'ACTIVE') : {}));
      await open(t, api, 'Cards');
      await t.tap(find.text('Debit card'));
      await t.pumpAndSettle();
      await t.tap(find.text('Freeze card'));
      await t.pumpAndSettle();
      expect(api.where('POST', '/api/v1/cards/c1/freeze').single.body, {'frozen': true});

      final limit = find.widgetWithText(TextField, 'Daily limit (LKR)');
      await t.ensureVisible(limit);
      await t.enterText(limit, '500.00'); // lower than 100,000.00
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();
      expect(find.text('App PIN'), findsNothing); // tightening: no PIN
      expect(api.where('PUT', '/api/v1/cards/c1/controls').last.body, {'dailyLimitMinor': 50000});

      await t.enterText(limit, '200000.00'); // higher
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();
      expect(find.text('App PIN'), findsOneWidget); // loosening: PIN sheet
      await enterPin(t);
      expect(api.where('PUT', '/api/v1/cards/c1/controls').last.body, {'dailyLimitMinor': 20000000, 'pin': '482916'});
    });

    testWidgets('a card the bank has blocked offers no controls', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/cards' ? {'items': [card('c1', 'BLOCKED')]} : card('c1', 'BLOCKED')));
      await open(t, api, 'Cards');
      await t.tap(find.text('Debit card'));
      await t.pumpAndSettle();
      expect(find.textContaining('permanently blocked'), findsOneWidget);
      expect(find.text('Freeze card'), findsNothing);
      expect(find.textContaining('Report lost'), findsNothing);
    });

    testWidgets('requesting a virtual card verifies with the PIN and tells the customer the bank will review it', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/branches' ? {'items': []} : p == '/api/v1/cards' ? {'items': []} : {'id': 'new'}));
      await open(t, api, 'Cards');
      await t.tap(find.text('Request a card'));
      await t.pumpAndSettle();
      await t.tap(find.text('Continue'));
      await t.pumpAndSettle();
      await enterPin(t);
      expect(api.where('POST', '/api/v1/cards').single.body, {'kind': 'VIRTUAL', 'accountId': 'a1', 'pin': '482916'});
      expect(find.text('Request received'), findsOneWidget);
      expect(find.textContaining('activated by the bank'), findsOneWidget);
    });

    testWidgets('a card ready to collect is activated by the customer with a card PIN plus the app PIN', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/cards' ? {'items': [card('c3', 'READY_TO_COLLECT')]} : p == '/api/v1/cards/c3' ? card('c3', 'READY_TO_COLLECT') : {}));
      await open(t, api, 'Cards');
      await t.tap(find.text('Debit card'));
      await t.pumpAndSettle();
      expect(find.textContaining('Colombo Fort'), findsOneWidget);
      await t.tap(find.text('Activate card'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, '4-digit card PIN'), '4821');
      await t.tap(find.text('Next'));
      await t.pumpAndSettle();
      await enterPin(t);
      expect(api.where('POST', '/api/v1/cards/c3/activate').single.body, {'pin': '482916', 'cardPin': '4821'});
    });
  });

  group('fixed deposits', () {
    Map<String, dynamic> fd({String status = 'ACTIVE'}) => {
          'id': 'f1', 'reference': 'FDABC123', 'status': status, 'principalMinor': 1000000, 'originalPrincipalMinor': 1000000, 'rateBps': 900, 'termMonths': 12, 'startDate': '2026-01-01T00:00:00Z', 'maturityDate': '2027-01-01T00:00:00Z',
          'renewal': 'WITH_INTEREST', 'renewalCount': 0, 'fundingAccountId': 'a1', 'interestAtMaturityMinor': 90000, 'maturityValueMinor': 1090000, 'daysLeft': 120, 'closureRequested': false,
        };

    testWidgets('shows what is locked away, interest to come and each deposit\'s terms', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? {'items': [fd()], 'lockedMinor': 1000000, 'interestToComeMinor': 90000});
      await open(t, api, 'Fixed deposits');
      expect(find.text('LKR 10,000.00'), findsWidgets);
      expect(find.textContaining('Interest still to come LKR 900.00'), findsOneWidget);
      expect(find.textContaining('1 year at 9.00%'), findsOneWidget);
      expect(find.textContaining('At maturity LKR 10,900.00'), findsOneWidget);
    });

    testWidgets('opening: shows the bank\'s quote, needs the PIN, sends an Idempotency-Key, and a dropped connection retries with the SAME key', (t) async {
      var fail = true;
      final api = FakeApi((p, q, b) {
        final x = base(p);
        if (x != null) return x;
        if (p == '/api/v1/fixed-deposits/rates') return {'items': [{'termMonths': 12, 'rateBps': 900, 'minAmountMinor': 1000000}, {'termMonths': 24, 'rateBps': 950, 'minAmountMinor': 1000000}]};
        if (p == '/api/v1/fixed-deposits/calculate') return {'termMonths': 12, 'rateBps': 900, 'interestMinor': 90000, 'maturityValueMinor': 1090000, 'maturityDate': '2027-03-01T00:00:00Z'};
        if (p == '/api/v1/fixed-deposits' && b != null) {
          if (fail) { fail = false; throw ApiFailure('network', 'offline', network: true); }
          return fd();
        }
        return {'items': [], 'lockedMinor': 0, 'interestToComeMinor': 0};
      });
      await open(t, api, 'Fixed deposits');
      await t.tap(find.text('Open a deposit'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Amount (LKR)'), '10000');
      await t.tap(find.widgetWithText(DropdownButtonFormField<int>, 'Term'));
      await t.pumpAndSettle();
      await t.tap(find.text('1 year · 9.00%').last);
      await t.pumpAndSettle();
      expect(find.textContaining('value at maturity LKR 10,900.00'), findsOneWidget);

      await t.ensureVisible(find.text('Open deposit'));
      await t.tap(find.text('Open deposit'));
      await t.pumpAndSettle();
      await enterPin(t);
      expect(find.textContaining('could not confirm'), findsOneWidget);
      expect(find.text('Deposit opened'), findsNothing);

      await t.ensureVisible(find.text('Open deposit'));
      await t.tap(find.text('Open deposit'));
      await t.pumpAndSettle();
      await enterPin(t);
      final posts = api.where('POST', '/api/v1/fixed-deposits').toList();
      expect(posts, hasLength(2));
      expect(posts[0].headers!['Idempotency-Key'], posts[1].headers!['Idempotency-Key']); // one key: the bank can never open two
      expect(posts[1].body, {'fundingAccountId': 'a1', 'amountMinor': 1000000, 'termMonths': 12, 'renewal': 'WITH_INTEREST', 'pin': '482916'});
      expect(find.text('Deposit opened'), findsOneWidget);
    });
  });

  group('loans', () {
    final loan = {
      'id': 'l1', 'reference': 'LNABC123', 'productName': 'Personal Loan', 'principalMinor': 30000000, 'outstandingPrincipalMinor': 30000000, 'rateBps': 1450, 'termMonths': 6, 'status': 'ACTIVE', 'startDate': '2026-03-01T00:00:00Z',
      'next': {'instalmentNo': 1, 'dueDate': '2026-04-01T00:00:00Z', 'dueMinor': 5300000, 'status': 'DUE'},
      'schedule': [
        {'no': 1, 'dueDate': '2026-04-01T00:00:00Z', 'principalMinor': 4900000, 'interestMinor': 400000, 'paidMinor': 0, 'status': 'DUE'},
        {'no': 2, 'dueDate': '2026-05-01T00:00:00Z', 'principalMinor': 5000000, 'interestMinor': 300000, 'paidMinor': 0, 'status': 'OVERDUE'},
      ],
    };

    testWidgets('lists loans with the next instalment and the application tracker (including a rejection reason)', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/loans' ? {'items': [loan], 'totalOutstandingMinor': 30000000} : {'items': [
            {'id': 'a1', 'productName': 'Vehicle Loan', 'amountMinor': 50000000, 'status': 'REJECTED', 'statusText': 'Not approved', 'decisionReason': 'Income not verifiable', 'steps': [{'label': 'Application received', 'done': true}, {'label': 'Under review', 'done': true}, {'label': 'Not approved', 'done': true}, {'label': 'Funds paid out', 'done': false}]},
          ]}));
      await open(t, api, 'Loans');
      expect(find.textContaining('Outstanding LKR 300,000.00'), findsOneWidget);
      expect(find.textContaining('Next instalment LKR 53,000.00'), findsOneWidget);
      expect(find.text('Not approved'), findsWidgets);
      expect(find.text('Income not verifiable'), findsOneWidget);
    });

    testWidgets('applying: shows an estimate labelled as not an approval, needs consent, and sends the application', (t) async {
      final api = FakeApi((p, q, b) {
        final x = base(p);
        if (x != null) return x;
        if (p == '/api/v1/loan-products') return {'items': [{'code': 'PERSONAL', 'name': 'Personal Loan', 'minAmountMinor': 5000000, 'maxAmountMinor': 500000000, 'minTermMonths': 6, 'maxTermMonths': 60, 'rateBps': 1450}]};
        if (p == '/api/v1/loans/calculate') return {'emiMinor': 5300000, 'totalInterestMinor': 1800000, 'totalPayableMinor': 31800000, 'eligibility': {'band': 'COMFORTABLE', 'incomeShareBps': 1500, 'disclaimer': 'This is an estimate to help you plan. It is not an approval and the bank may decide differently.'}};
        if (p == '/api/v1/loan-applications' && b != null) return {'id': 'x', 'status': 'SUBMITTED'};
        return {'items': [], 'totalOutstandingMinor': 0};
      });
      await open(t, api, 'Loans');
      await t.tap(find.text('Apply for a loan'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(DropdownButtonFormField<String>, 'Loan type'));
      await t.pumpAndSettle();
      await t.tap(find.text('Personal Loan · 14.50%').last);
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextFormField, 'Amount (LKR)'), '300000');
      await t.enterText(find.widgetWithText(TextFormField, 'Term (months)'), '6');
      await t.enterText(find.widgetWithText(TextFormField, 'Monthly income (LKR)'), '200000');
      await t.enterText(find.widgetWithText(TextFormField, 'Employment'), 'Engineer');
      await t.pumpAndSettle();
      expect(find.textContaining('Estimated instalment LKR 53,000.00'), findsOneWidget);
      expect(find.textContaining('not an approval'), findsOneWidget);

      await t.ensureVisible(find.text('Submit application'));
      expect(t.widget<FilledButton>(find.ancestor(of: find.text('Submit application'), matching: find.byType(FilledButton))).onPressed, isNull); // consent first
      await t.tap(find.byType(CheckboxListTile));
      await t.pumpAndSettle();
      await t.tap(find.text('Submit application'));
      await t.pumpAndSettle();
      final sent = api.where('POST', '/api/v1/loan-applications').single.body!;
      expect(sent, containsPair('consent', true));
      expect(sent, containsPair('amountMinor', 30000000));
      expect(sent, containsPair('monthlyIncomeMinor', 20000000));
      expect(find.text('Application received'), findsOneWidget);
      expect(find.textContaining('Nothing has been approved'), findsOneWidget);
    });

    testWidgets('paying the next instalment goes through the normal payment review with the bank\'s amount', (t) async {
      final api = FakeApi((p, q, b) {
        final x = base(p);
        if (x != null) return x;
        if (p == '/api/v1/loans') return {'items': [loan], 'totalOutstandingMinor': 30000000};
        if (p == '/api/v1/loans/l1') return loan;
        if (p == '/api/v1/loan-applications') return {'items': []};
        if (p == '/api/v1/payments') {
          return {'id': 'p1', 'reference': 'ZX1', 'kind': 'LOAN_INSTALMENT', 'status': 'AWAITING_AUTHORIZATION', 'amountMinor': 5300000, 'feeMinor': 0, 'totalMinor': 5300000, 'currency': 'LKR', 'sourceAccountId': 'a1', 'recipient': {'name': 'Personal Loan LNABC123', 'accountMasked': 'LNABC123', 'bank': 'Zentrix Bank loan'}, 'note': 'Loan repayment', 'scheduledFor': null, 'createdAt': '2026-03-01T10:00:00Z', 'postedAt': null, 'failureCode': null, 'failureMessage': null};
        }
        return {};
      });
      await open(t, api, 'Loans');
      await t.tap(find.textContaining('Personal Loan · LNABC123'));
      await t.pumpAndSettle();
      expect(find.text('Overdue'), findsOneWidget); // schedule status from the bank
      await t.tap(find.textContaining('Pay next instalment'));
      await t.pumpAndSettle();
      final create = api.where('POST', '/api/v1/payments').single;
      expect(create.body, {'sourceAccountId': 'a1', 'destination': {'type': 'LOAN', 'loanId': 'l1'}, 'amountMinor': 5300000, 'note': 'Loan repayment'});
      expect(create.headers!['Idempotency-Key'], isNotEmpty);
      expect(find.text('Review payment'), findsOneWidget);
      expect(find.textContaining('Personal Loan LNABC123'), findsOneWidget);
    });
  });

  group('savings and budgets', () {
    testWidgets('goals show progress; adding money needs the PIN and sends an Idempotency-Key', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? (p == '/api/v1/savings/goals' && b == null ? {'items': [{'id': 'g1', 'name': 'Holiday', 'targetMinor': 1000000, 'savedMinor': 250000, 'progressPercent': 25, 'status': 'ACTIVE', 'targetDate': null}], 'totalSavedMinor': 250000} : {'id': 'g1'}));
      await open(t, api, 'Savings goals');
      expect(find.text('Holiday'), findsOneWidget);
      expect(find.text('LKR 2,500.00 of LKR 10,000.00 (25%)'), findsOneWidget);
      await t.tap(find.text('Add money'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Amount (LKR)'), '500');
      await t.tap(find.text('Continue'));
      await t.pumpAndSettle();
      await enterPin(t);
      final post = api.where('POST', '/api/v1/savings/goals/g1/contribute').single;
      expect(post.body, {'accountId': 'a1', 'amountMinor': 50000, 'pin': '482916'});
      expect(post.headers!['Idempotency-Key'], matches(RegExp(r'^[0-9a-f]{32}$')));
    });

    testWidgets('budgets show spending against each limit and call out an overspend', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? {'items': [
            {'category': 'Electricity', 'limitMinor': 100000, 'spentMinor': 111000, 'remainingMinor': -11000, 'percentUsed': 111, 'state': 'OVER'},
            {'category': 'Water', 'limitMinor': 50000, 'spentMinor': 5000, 'remainingMinor': 45000, 'percentUsed': 10, 'state': 'OK'},
          ], 'categories': ['Electricity', 'Water', 'Transfers']});
      await open(t, api, 'Budgets');
      expect(find.textContaining('over budget'), findsOneWidget);
      expect(find.text('LKR 1,110.00 of LKR 1,000.00 · 111% — over budget'), findsOneWidget);
      expect(find.text('LKR 50.00 of LKR 500.00 · 10%'), findsOneWidget);
      expect(find.textContaining('never block a payment'), findsOneWidget);
    });
  });
}
