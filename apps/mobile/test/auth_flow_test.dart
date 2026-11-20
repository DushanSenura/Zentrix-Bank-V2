import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

class FakeAuthRepository implements AuthRepository {
  FakeAuthRepository({this.restoreAs, this.failLogin = false, this.correctPin = '482916'});
  final Me? restoreAs;
  final bool failLogin;
  final String correctPin;
  bool loggedOut = false;
  int pinChecks = 0;

  static const amaya = Me(id: '1', fullName: 'Amaya Perera', status: 'PENDING_VERIFICATION', kycStatus: 'NOT_SUBMITTED', hasPin: false, customerNumber: 'ZB90000001');
  static const amayaWithPin = Me(id: '1', fullName: 'Amaya Perera', status: 'ACTIVE', kycStatus: 'APPROVED', hasPin: true, customerNumber: 'ZB90000001');

  @override
  Future<Me?> restore() async => restoreAs;
  @override
  Future<Me> login(String identifier, String password, {bool remember = false, String? mfaCode, String? recoveryCode}) async {
    if (failLogin) throw ApiFailure('invalid_credentials', 'Invalid credentials');
    return amaya;
  }
  @override
  Future<void> verifyPin(String pin) async {
    pinChecks++;
    if (pin != correctPin) throw ApiFailure('invalid_pin', 'Incorrect PIN');
  }
  @override
  Future<void> logout() async => loggedOut = true;
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

class FakeBiometrics implements BiometricService {
  FakeBiometrics({this.ok = true});
  final bool ok;
  int prompts = 0;
  @override
  Future<bool> available() async => true;
  @override
  Future<bool> authenticate(String reason) async { prompts++; return ok; }
}

Widget app(FakeAuthRepository repo, {bool onboarded = true, bool biometric = false, FakeBiometrics? bio, String? lockMinutes}) {
  final prefs = MemoryPrefsStore();
  if (onboarded) prefs.data['onboarded'] = '1';
  if (biometric) prefs.data['biometric'] = '1';
  if (lockMinutes != null) prefs.data['lockMinutes'] = lockMinutes;
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(repo),
      prefsStoreProvider.overrideWithValue(prefs),
      biometricServiceProvider.overrideWithValue(bio ?? FakeBiometrics()),
    ],
    child: const ZentrixApp(),
  );
}

void main() {
  demoTests();
  testWidgets('first launch shows onboarding, which leads to login and is not shown again', (t) async {
    await t.pumpWidget(app(FakeAuthRepository(), onboarded: false));
    await t.pumpAndSettle();
    expect(find.text('All your money, one place'), findsOneWidget);
    await t.tap(find.text('Next'));
    await t.pumpAndSettle();
    await t.tap(find.text('Next'));
    await t.pumpAndSettle();
    await t.tap(find.text('Get started'));
    await t.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
  });

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

  testWidgets('a remembered session without a PIN skips login; sign out returns to login', (t) async {
    final repo = FakeAuthRepository(restoreAs: FakeAuthRepository.amaya);
    await t.pumpWidget(app(repo));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
    await t.tap(find.text('Sign out'));
    await t.pumpAndSettle();
    expect(repo.loggedOut, isTrue);
    expect(find.text('Welcome back'), findsOneWidget);
  });

  testWidgets('a remembered session WITH a PIN opens locked; wrong PIN is refused, server-verified PIN unlocks', (t) async {
    final repo = FakeAuthRepository(restoreAs: FakeAuthRepository.amayaWithPin);
    await t.pumpWidget(app(repo));
    await t.pumpAndSettle();
    expect(find.text('Welcome back, Amaya'), findsOneWidget);
    expect(find.text('Hello, Amaya'), findsNothing); // content is not reachable while locked

    await t.enterText(find.byType(TextField), '000000');
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(find.text('Incorrect PIN'), findsOneWidget);

    await t.enterText(find.byType(TextField), '482916');
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(repo.pinChecks, 2);
    expect(find.text('Hello, Amaya'), findsOneWidget);
  });

  testWidgets('biometric success unlocks without a PIN; failure keeps the lock', (t) async {
    final ok = FakeBiometrics();
    await t.pumpWidget(app(FakeAuthRepository(restoreAs: FakeAuthRepository.amayaWithPin), biometric: true, bio: ok));
    await t.pumpAndSettle();
    expect(ok.prompts, 1);
    expect(find.text('Hello, Amaya'), findsOneWidget);
  });

  testWidgets('failed biometrics leave the app locked', (t) async {
    final bad = FakeBiometrics(ok: false);
    await t.pumpWidget(app(FakeAuthRepository(restoreAs: FakeAuthRepository.amayaWithPin), biometric: true, bio: bad));
    await t.pumpAndSettle();
    expect(bad.prompts, 1);
    expect(find.text('Welcome back, Amaya'), findsOneWidget);
    expect(find.text('Use biometrics'), findsOneWidget);
  });

  testWidgets('privacy cover shows while inactive; a quick return within the timeout stays unlocked', (t) async {
    final repo = FakeAuthRepository(restoreAs: FakeAuthRepository.amaya.copyWith2(hasPin: true));
    await t.pumpWidget(app(repo, biometric: false));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '482916');
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);

    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await t.pump();
    expect(find.byType(Image), findsWidgets); // cover (logo) drawn over the app
    // default timeout is 2 min; "resume" immediately => stays unlocked
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
  });

  testWidgets('returning after the auto-lock timeout re-locks the app', (t) async {
    final repo = FakeAuthRepository(restoreAs: FakeAuthRepository.amaya.copyWith2(hasPin: true));
    await t.pumpWidget(app(repo, lockMinutes: '0'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '482916');
    await t.tap(find.text('Unlock'));
    await t.pumpAndSettle();
    expect(find.text('Hello, Amaya'), findsOneWidget);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await t.pump();
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
    expect(find.text('Welcome back, Amaya'), findsOneWidget);
    expect(find.text('Hello, Amaya'), findsNothing);
  });

  testWidgets('login screen honours dark theme and large text without overflow', (t) async {
    t.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(t.platformDispatcher.clearAllTestValues);
    await t.pumpWidget(MediaQuery(data: const MediaQueryData(textScaler: TextScaler.linear(2.0), size: Size(390, 844)), child: app(FakeAuthRepository())));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('Welcome back'), findsOneWidget);
  });
}

extension on Me {
  Me copyWith2({bool? hasPin}) => Me(id: id, fullName: fullName, status: status, kycStatus: kycStatus, hasPin: hasPin ?? this.hasPin, customerNumber: customerNumber);
}

// ───────────────────────── demo customers on the sign-in screen (debug builds) ─────────────────────────
class _DemoRepo extends FakeAuthRepository {
  _DemoRepo(this.demo) : super();
  final List<DemoAccount> demo;
  @override
  Future<List<DemoAccount>> demoAccounts() async => demo;
}

void demoTests() {
  Widget app(AuthRepository repo) => ProviderScope(
        overrides: [authRepositoryProvider.overrideWithValue(repo), prefsStoreProvider.overrideWithValue(MemoryPrefsStore()..data['onboarded'] = '1'), biometricServiceProvider.overrideWithValue(FakeBiometrics())],
        child: const ZentrixApp(),
      );

  testWidgets('sign-in lists the demo customers and fills the form when one is chosen', (t) async {
    await t.pumpWidget(app(_DemoRepo(const [DemoAccount(username: 'amaya.demo', password: 'demo-pass-1', fullName: 'Amaya Perera (fictional)', pin: '482916')])));
    await t.pumpAndSettle();
    expect(find.text('Amaya Perera (fictional)'), findsOneWidget);
    expect(find.textContaining('App PIN: 482916'), findsOneWidget);
    await t.tap(find.text('Use'));
    await t.pumpAndSettle();
    expect(find.widgetWithText(TextFormField, 'amaya.demo'), findsOneWidget);
  });

  testWidgets('sign-in shows no demo section when the server offers none', (t) async {
    await t.pumpWidget(app(_DemoRepo(const [])));
    await t.pumpAndSettle();
    expect(find.textContaining('Demo customers'), findsNothing);
    expect(find.text('Sign in'), findsOneWidget);
  });
}
