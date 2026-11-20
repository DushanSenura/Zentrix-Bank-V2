import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/core/design_system/async_view.dart';
import 'package:zentrix_bank/core/network/resilience.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

import 'fake_api.dart';

class FakeOnline implements OnlineService {
  FakeOnline(bool initial) : _now = initial;
  bool _now;
  final _c = StreamController<bool>.broadcast();
  void set(bool v) { _now = v; _c.add(v); }
  @override
  Future<bool> current() async => _now;
  @override
  Stream<bool> changes() => _c.stream;
}

class RecordingReporter implements CrashReporter {
  final reports = <String>[];
  @override
  void report(Object error, StackTrace? stack, {String? where}) => reports.add('${error.runtimeType}:$where');
}

class MaintenanceApi extends FakeApi {
  MaintenanceApi(super.handler);
  String? statusNow = 'Back at 6am.';
  @override
  Future<String?> maintenanceStatus() async => statusNow;
}

Widget app(FakeApi api, FakeOnline online) => ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(api),
        onlineServiceProvider.overrideWithValue(online),
        prefsStoreProvider.overrideWithValue(MemoryPrefsStore()..data['onboarded'] = '1'),
        biometricServiceProvider.overrideWithValue(NoBio()),
      ],
      child: const ZentrixApp(),
    );

FakeApi homeApi() => FakeApi((p, q, b) {
      if (p == '/api/v1/accounts') return {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000};
      if (p == '/api/v1/notifications') return {'unread': 0, 'items': []};
      return {'items': []};
    });

void main() {
  tearDown(() { maintenanceNotifier.value = null; sessionExpiredNotifier.value = false; });

  testWidgets('an offline banner appears when the phone loses its connection and goes when it returns', (t) async {
    final online = FakeOnline(true);
    await t.pumpWidget(app(homeApi(), online));
    await t.pumpAndSettle();
    expect(find.textContaining('You are offline'), findsNothing);
    online.set(false);
    await t.pumpAndSettle();
    expect(find.textContaining('You are offline'), findsOneWidget);
    online.set(true);
    await t.pumpAndSettle();
    expect(find.textContaining('You are offline'), findsNothing);
  });

  testWidgets('maintenance covers the app with a notice, keeps it up while the bank is still closed, and lifts when it reopens', (t) async {
    final api = MaintenanceApi((p, q, b) => p == '/api/v1/accounts' ? {'items': [acct('a1', 'Main savings', 5000000)], 'totalBalanceMinor': 5000000} : {'unread': 0, 'items': []});
    await t.pumpWidget(app(api, FakeOnline(true)));
    await t.pumpAndSettle();
    expect(find.text('Back soon'), findsNothing);
    maintenanceNotifier.value = 'Back at 6am.';
    await t.pumpAndSettle();
    expect(find.text('Back soon'), findsOneWidget);
    expect(find.text('Back at 6am.'), findsOneWidget);

    await t.tap(find.text('Try again')); // still closed
    await t.pumpAndSettle();
    expect(find.text('Back soon'), findsOneWidget);

    api.statusNow = null; // reopened
    await t.tap(find.text('Try again'));
    await t.pumpAndSettle();
    expect(find.text('Back soon'), findsNothing);
    expect(find.textContaining('Total balance'), findsOneWidget); // the app underneath was never lost
  });

  testWidgets('when the session cannot be renewed the customer is signed out with a clear reason', (t) async {
    await t.pumpWidget(app(homeApi(), FakeOnline(true)));
    await t.pumpAndSettle();
    expect(find.textContaining('Total balance'), findsOneWidget);
    sessionExpiredNotifier.value = true;
    await t.pumpAndSettle();
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.textContaining('Your session ended'), findsOneWidget);
    expect(sessionExpiredNotifier.value, isFalse); // consumed
  });

  testWidgets('a failed load shows the bank\'s short reference so support can find the request', (t) async {
    final err = ApiFailure('error', 'Something went wrong on our side. Please try again.', requestId: 'ab12cd34');
    expect(errorReference(err), 'Reference ab12cd34');
    expect(errorReference(ApiFailure('x', 'y')), isNull);
    expect(errorReference(StateError('no')), isNull);
  });

  test('crash handling reports framework and async errors to the reporter', () async {
    final previousFlutter = FlutterError.onError;
    final previousPlatform = PlatformDispatcher.instance.onError;
    addTearDown(() { FlutterError.onError = previousFlutter; PlatformDispatcher.instance.onError = previousPlatform; });
    final r = RecordingReporter();
    installErrorHandling(r);
    FlutterError.onError!(FlutterErrorDetails(exception: StateError('boom'), library: 'tests'));
    expect(r.reports, ['StateError:tests']);
    expect(PlatformDispatcher.instance.onError!(ArgumentError('x'), StackTrace.current), isTrue);
    expect(r.reports.last, 'ArgumentError:async');
  });
}
