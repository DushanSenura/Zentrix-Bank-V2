import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/support/data/file_sharer.dart';
import 'package:zentrix_bank/features/support/data/support_repository.dart';
import 'package:zentrix_bank/features/support/presentation/support_pages.dart';

import 'fake_api.dart';

Map<String, dynamic>? base(String p) {
  if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
  if (p == '/api/v1/notifications') return {'unread': 0, 'items': []};
  if (p == '/api/v1/transactions') return {'items': [], 'nextCursor': null}; // the home screen's recent-transactions list
  if (p == '/api/v1/analytics/summary') return {}; // the home screen's month overview (unparseable on purpose: it just stays hidden)
  return null;
}

Map<String, dynamic> txn(String id, String desc, int amount, {String? paymentId}) => {
      'id': id, 'accountId': 'a1', 'accountLabel': 'Main savings', 'reference': 'R$id', 'kind': 'TRANSFER', 'description': desc,
      'amountMinor': amount, 'currency': 'LKR', 'status': 'POSTED', 'postedAt': '2026-03-05T10:00:00Z', 'paymentId': paymentId,
    };

/// Mounts one page inside a real router so context.push/go work, with stubs for the pages it navigates to.
Widget pageApp(FakeApi api, Widget page, {RecordingSharer? sharer}) {
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => page),
    GoRoute(path: '/support/disputes', builder: (_, _) => const Scaffold(body: Text('disputes page'))),
  ]);
  return ProviderScope(
    overrides: [authRepositoryProvider.overrideWithValue(api), if (sharer != null) fileSharerProvider.overrideWithValue(sharer)],
    child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router),
  );
}

/// Same as FakeApi, but file downloads are refused by the bank.
class FailingFileApi extends FakeApi {
  FailingFileApi(super.handler);
  @override
  Future<DownloadedFile> getFile(String path, {Map<String, dynamic>? query}) async => throw ApiFailure('too_many_rows', 'That period has more than 5000 entries.');
}

void main() {
  group('history', () {
    testWidgets('shows signed amounts, filters on the server and pages with the cursor', (t) async {
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/transactions') {
          if (q?['cursor'] == 'c1') return {'items': [txn('t3', 'Older payment', -500)], 'nextCursor': null};
          return {'items': [txn('t1', 'Salary', 250000), txn('t2', 'Groceries', -125050, paymentId: 'p1')], 'nextCursor': 'c1'};
        }
        return base(p) ?? {};
      });
      await t.pumpWidget(pageApp(api, const HistoryPage()));
      await t.pumpAndSettle();
      expect(find.text('Salary'), findsOneWidget);
      expect(find.text('+LKR 2,500.00'), findsOneWidget);
      expect(find.text('-LKR 1,250.50'), findsOneWidget);

      await t.tap(find.text('Load more'));
      await t.pumpAndSettle();
      expect(find.text('Older payment'), findsOneWidget);
      expect(find.text('Load more'), findsNothing);
      expect(api.where('GET', '/api/v1/transactions').last.query!['cursor'], 'c1');

      await t.tap(find.text('Money out'));
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/transactions').last.query!['direction'], 'OUT');
      expect(api.where('GET', '/api/v1/transactions').last.query!.containsKey('cursor'), isFalse); // a new filter starts from the top

      await t.enterText(find.widgetWithText(TextField, 'Search description or reference'), 'g');
      await t.testTextInput.receiveAction(TextInputAction.search);
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/transactions').last.query!.containsKey('q'), isFalse); // under 2 characters is not sent
      await t.enterText(find.widgetWithText(TextField, 'Search description or reference'), 'groceries');
      await t.testTextInput.receiveAction(TextInputAction.search);
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/transactions').last.query!['q'], 'groceries');
    });

    testWidgets('an empty result and a failure are both explained', (t) async {
      var fail = false;
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/transactions') {
          if (fail) throw ApiFailure('error', 'Something went wrong on our side. Please try again.');
          return {'items': [], 'nextCursor': null};
        }
        return base(p) ?? {};
      });
      await t.pumpWidget(pageApp(api, const HistoryPage()));
      await t.pumpAndSettle();
      expect(find.text('No transactions match.'), findsOneWidget);
      fail = true;
      await t.tap(find.text('Money in'));
      await t.pumpAndSettle();
      expect(find.text('Something went wrong on our side. Please try again.'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('statements', () {
    testWidgets('requests the PDF from the bank for the chosen period and hands it to the share sheet', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? {});
      final sharer = RecordingSharer();
      await t.pumpWidget(pageApp(api, const StatementsPage(), sharer: sharer));
      await t.pumpAndSettle();
      await t.tap(find.text('Download and share'));
      await t.pumpAndSettle();
      final r = api.where('GET', '/api/v1/accounts/a1/statement').single;
      expect(r.query!['format'], 'pdf');
      expect(r.query!['lang'], 'en');
      expect(RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(r.query!['from'] as String), isTrue);
      expect(sharer.shared, hasLength(1));
      expect(sharer.shared.single.fileName, 'doc.pdf');

      await t.tap(find.text('CSV (spreadsheet)'));
      await t.pumpAndSettle();
      await t.tap(find.text('Download and share'));
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/accounts/a1/statement').last.query!['format'], 'csv');
    });

    testWidgets('shows the bank refusal when a statement cannot be produced', (t) async {
      final api = FailingFileApi((p, q, b) => base(p) ?? {});
      await t.pumpWidget(pageApp(api, const StatementsPage(), sharer: RecordingSharer()));
      await t.pumpAndSettle();
      await t.tap(find.text('Download and share'));
      await t.pumpAndSettle();
      expect(find.text('That period has more than 5000 entries.'), findsOneWidget);
    });
  });

  group('report a problem', () {
    testWidgets('needs a description, then sends exactly what was chosen', (t) async {
      final api = FakeApi((p, q, b) => p == '/api/v1/disputes' && b != null ? {'id': 'd1'} : (base(p) ?? {'items': []}));
      await t.pumpWidget(pageApp(api, const ReportProblemPage(paymentId: 'pay-1')));
      await t.pumpAndSettle();
      await t.tap(find.text('Send report'));
      await t.pumpAndSettle();
      expect(find.textContaining('at least 10 characters'), findsOneWidget);
      expect(api.where('POST', '/api/v1/disputes'), isEmpty);

      await t.enterText(find.widgetWithText(TextField, 'Tell us more'), 'I never made this payment');
      await t.tap(find.text('Send report'));
      await t.pumpAndSettle();
      final sent = api.where('POST', '/api/v1/disputes').single.body!;
      expect(sent, {'paymentId': 'pay-1', 'reasonCode': 'UNAUTHORISED', 'description': 'I never made this payment'});
      expect(find.text('disputes page'), findsOneWidget);
    });

    testWidgets('a duplicate report is explained, not swallowed', (t) async {
      final api = FakeApi((p, q, b) {
        if (p == '/api/v1/disputes' && b != null) throw ApiFailure('already_reported', 'You already reported this payment');
        return base(p) ?? {};
      });
      await t.pumpWidget(pageApp(api, const ReportProblemPage(paymentId: 'pay-1')));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Tell us more'), 'Charged twice for the same thing');
      await t.tap(find.text('Send report'));
      await t.pumpAndSettle();
      expect(find.text('You already reported this payment'), findsOneWidget);
      expect(find.text('disputes page'), findsNothing);
    });
  });

  group('support requests', () {
    Map<String, dynamic> ticket(List<Map<String, dynamic>> msgs, {String status = 'PENDING_CUSTOMER'}) => {
          'id': 't1', 'reference': 'ST1', 'subject': 'Card missing', 'category': 'CARD', 'status': status, 'statusText': 'Waiting for your reply',
          'createdAt': '2026-03-01T10:00:00Z', 'updatedAt': '2026-03-02T10:00:00Z', 'messages': msgs,
        };

    testWidgets('shows the conversation and sends a reply', (t) async {
      final msgs = [
        {'id': 'm1', 'from': 'CUSTOMER', 'body': 'Where is my card?', 'at': '2026-03-01T10:00:00Z'},
        {'id': 'm2', 'from': 'STAFF', 'body': 'It ships tomorrow', 'at': '2026-03-02T10:00:00Z'},
      ];
      final api = FakeApi((p, q, b) => p == '/api/v1/support/tickets/t1' ? ticket(msgs) : (base(p) ?? {'items': []}));
      await t.pumpWidget(pageApp(api, const TicketDetailPage(id: 't1')));
      await t.pumpAndSettle();
      expect(find.text('Where is my card?'), findsOneWidget);
      expect(find.text('It ships tomorrow'), findsOneWidget);
      expect(find.text('Zentrix Bank'), findsOneWidget);

      await t.enterText(find.widgetWithText(TextField, 'Your reply'), 'Thanks!');
      await t.tap(find.text('Send reply'));
      await t.pumpAndSettle();
      expect(api.where('POST', '/api/v1/support/tickets/t1/messages').single.body, {'body': 'Thanks!'});
    });

    testWidgets('a closed request cannot be replied to', (t) async {
      final api = FakeApi((p, q, b) => p == '/api/v1/support/tickets/t1' ? ticket([], status: 'CLOSED') : (base(p) ?? {}));
      await t.pumpWidget(pageApp(api, const TicketDetailPage(id: 't1')));
      await t.pumpAndSettle();
      expect(find.text('Send reply'), findsNothing);
      expect(find.textContaining('This request is closed'), findsOneWidget);
    });

    testWidgets('a new request is validated before anything is sent', (t) async {
      final api = FakeApi((p, q, b) => base(p) ?? {'items': []});
      await t.pumpWidget(pageApp(api, const NewTicketPage()));
      await t.pumpAndSettle();
      await t.tap(find.text('Send'));
      await t.pumpAndSettle();
      expect(find.text('Please add a subject and a short message.'), findsOneWidget);
      expect(api.where('POST', '/api/v1/support/tickets'), isEmpty);
    });
  });

  group('branches', () {
    testWidgets('lists locations; only branches can be booked, not ATMs', (t) async {
      final api = FakeApi((p, q, b) => p == '/api/v1/branches'
          ? {
              'items': [
                {'id': 'b1', 'name': 'Colombo Fort', 'city': 'Colombo', 'address': '1 Main St', 'type': 'BRANCH', 'phone': '+94 11 000 0000', 'hours': 'Mon-Fri 9-4'},
                {'id': 'b2', 'name': 'Fort ATM', 'city': 'Colombo', 'address': 'Station Rd', 'type': 'ATM'},
              ],
            }
          : (base(p) ?? {}));
      await t.pumpWidget(pageApp(api, const BranchesPage()));
      await t.pumpAndSettle();
      expect(find.text('Colombo Fort'), findsOneWidget);
      expect(find.text('Fort ATM'), findsOneWidget);
      expect(find.text('Book'), findsOneWidget);

      await t.tap(find.text('ATMs'));
      await t.pumpAndSettle();
      expect(api.where('GET', '/api/v1/branches').last.query!['type'], 'ATM');
    });
  });
}
