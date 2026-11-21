import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:zentrix_bank/features/authentication/presentation/auth_pages.dart' show LoginPage;
import 'package:zentrix_bank/features/authentication/presentation/onboarding_carousel.dart' show OnboardingPage;

import 'accessibility_test.dart' show host, pages;
import 'fake_api.dart';

/// Every screen in the shared page list, at real viewport sizes and text scales, in both themes.
/// A RenderFlex overflow or any framework exception fails the case (the exception is read with takeException).
const viewports = <(String, Size)>[
  ('320x568', Size(320, 568)),
  ('360x640', Size(360, 640)),
  ('390x844', Size(390, 844)),
  ('412x915', Size(412, 915)),
  ('600x960', Size(600, 960)),
  ('768x1024', Size(768, 1024)),
  ('1024x1366', Size(1024, 1366)),
  ('844x390 landscape', Size(844, 390)),
];
const scales = [1.0, 1.6, 2.0];

/// The signed-in home screen with several accounts, long names and a large balance.
FakeApi homeApi() => FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') {
        return {'items': [acct('a1', 'Main savings account with a very long nickname', 987654321000), acct('a2', 'Salary', 150000), acct('a3', 'Holiday fund', 0, status: 'FROZEN')], 'totalBalanceMinor': 987804321000};
      }
      if (p == '/api/v1/notifications') return {'unread': 12, 'items': []};
      if (p == '/api/v1/me/preferences') return {'defaultAccountId': null, 'notifications': {}, 'alwaysOn': ['SECURITY']};
      if (p == '/api/v1/transactions') return {'items': [{'id': 't1', 'accountId': 'a1', 'accountLabel': 'Main savings account with a very long nickname', 'reference': 'R1', 'kind': 'TRANSFER', 'description': 'Payment to Kamal Wickramasinghe-Perera for the annual membership', 'amountMinor': -123456789, 'currency': 'LKR', 'status': 'POSTED', 'postedAt': '2026-03-05T10:00:00Z', 'paymentId': 'p1'}], 'nextCursor': null};
      return {};
    });

void main() {
  for (final v in viewports) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('home dashboard @ ${v.$1}, ${scale}x text', (t) async {
        t.view.physicalSize = v.$2 * 2;
        t.view.devicePixelRatio = 2;
        addTearDown(t.view.reset);
        await t.pumpWidget(appWith(homeApi()));
        await t.pumpAndSettle();
        expect(find.textContaining('Hello'), findsWidgets);
        expect(t.takeException(), isNull);
      });
      for (final e in {'login': () => const LoginPage(), 'onboarding': () => const OnboardingPage()}.entries) {
        testWidgets('${e.key} @ ${v.$1}, ${scale}x text', (t) async {
          t.view.physicalSize = v.$2 * 2;
          t.view.devicePixelRatio = 2;
          addTearDown(t.view.reset);
          await t.pumpWidget(host(e.value(), scale: scale));
          await t.pump(const Duration(milliseconds: 600));
          expect(t.takeException(), isNull);
        });
      }
    }
  }
  for (final v in viewports) {
    for (final scale in scales) {
      for (final dark in [false, true]) {
        // Dark only at the extremes to keep the matrix quick; light covers every combination.
        if (dark && !(scale == 1.0 || scale == 2.0)) continue;
        for (final e in pages.entries) {
          testWidgets('${e.key} @ ${v.$1}, ${scale}x text, ${dark ? 'dark' : 'light'}', (t) async {
            t.view.physicalSize = v.$2 * 2;
            t.view.devicePixelRatio = 2;
            addTearDown(t.view.reset);
            await t.pumpWidget(host(e.value(), brightness: dark ? Brightness.dark : Brightness.light, scale: scale));
            await t.pumpAndSettle();
            expect(t.takeException(), isNull);
          });
        }
      }
    }
  }
}
