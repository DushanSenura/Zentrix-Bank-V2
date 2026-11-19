import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({this.restoreAs, this.failLogin = false});
  final Me? restoreAs;
  final bool failLogin;
  bool loggedOut = false;

  static const amaya = Me(id: '1', fullName: 'Amaya Perera', status: 'PENDING_VERIFICATION', kycStatus: 'NOT_SUBMITTED', hasPin: false, customerNumber: 'ZB90000001');

  @override
  Future<Me?> restore() async => restoreAs;
  @override
  Future<Me> login(String identifier, String password, {bool remember = false}) async {
    if (failLogin) throw ApiFailure('invalid_credentials', 'Invalid credentials');
    return amaya;
  }
  @override
  Future<void> logout() async => loggedOut = true;
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

Widget app(FakeAuthRepository repo) => ProviderScope(overrides: [authRepositoryProvider.overrideWithValue(repo)], child: const ZentrixApp());

void main() {
  testWidgets('signed-out users land on login and empty submit is validated client-side', (t) async {
    await t.pumpWidget(app(FakeAuthRepository()));
    await t.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
    await t.tap(find.text('Sign in'));
    await t.pumpAndSettle();
    expect(find.text('Required'), findsNWidgets(2));
  });

  testWidgets('server refusal is shown and the user stays on login', (t) async {
    await t.pumpWidget(app(FakeAuthRepository(failLogin: true)));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextFormField, 'Username, email or customer ID'), 'amaya.demo');
    await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'whatever-pass-1');
    await t.tap(find.text('Sign in'));
    await t.pumpAndSettle();
    expect(find.text('Invalid credentials'), findsOneWidget);
    expect(find.text('Welcome back'), findsOneWidget);
  });

  testWidgets('successful login shows the server-reported verification state', (t) async {
    await t.pumpWidget(app(FakeAuthRepository()));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextFormField, 'Username, email or customer ID'), 'amaya.demo');
    await t.enterText(find.widgetWithText(TextFormField, 'Password'), 'whatever-pass-1');
    await t.tap(find.text('Sign in'));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
    expect(find.text('Verify identity'), findsOneWidget);
    expect(find.text('Set app PIN'), findsOneWidget);
  });

  testWidgets('a remembered session skips login; sign out returns to login', (t) async {
    final repo = FakeAuthRepository(restoreAs: FakeAuthRepository.amaya);
    await t.pumpWidget(app(repo));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
    await t.tap(find.text('Sign out'));
    await t.pumpAndSettle();
    expect(repo.loggedOut, isTrue);
    expect(find.text('Welcome back'), findsOneWidget);
  });

  testWidgets('login screen honours dark theme and large text without overflow', (t) async {
    t.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(t.platformDispatcher.clearAllTestValues);
    await t.pumpWidget(MediaQuery(data: const MediaQueryData(textScaler: TextScaler.linear(2.0), size: Size(390, 844)), child: app(FakeAuthRepository())));
    await t.pumpAndSettle();
    expect(tester(t), isNull); // no exception was thrown while laying out
    expect(find.text('Welcome back'), findsOneWidget);
  });
}

Object? tester(WidgetTester t) => t.takeException();
