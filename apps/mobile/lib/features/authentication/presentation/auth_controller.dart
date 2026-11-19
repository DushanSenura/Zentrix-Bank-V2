import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../settings/settings_controller.dart';
import '../data/auth_repository.dart';

class AuthState {
  const AuthState({this.me, this.restoring = true});
  final Me? me;
  final bool restoring; // true until the first restore attempt finishes (splash)
  bool get signedIn => me != null;
}

/// Whether the app is locked behind PIN/biometrics. The server session stays valid while locked.
class LockController extends Notifier<bool> {
  @override
  bool build() => false;
  void lock() => state = true;
  void unlock() => state = false;
}

final lockProvider = NotifierProvider<LockController, bool>(LockController.new);

class AuthController extends Notifier<AuthState> {
  AuthRepository get _repo => ref.read(authRepositoryProvider);

  @override
  AuthState build() {
    Future.microtask(_restore);
    return const AuthState();
  }

  Future<void> _restore() async {
    await ref.read(settingsProvider.notifier).load();
    final me = await _repo.restore();
    // A remembered session on a cold start must be re-confirmed with PIN/biometrics.
    if (me != null && me.hasPin) ref.read(lockProvider.notifier).lock();
    state = AuthState(me: me, restoring: false);
  }

  Future<void> login(String identifier, String password, {bool remember = false}) async {
    final me = await _repo.login(identifier, password, remember: remember);
    ref.read(lockProvider.notifier).unlock();
    state = AuthState(me: me, restoring: false);
  }

  Future<void> register({required String fullName, required String username, required String email, required String password}) async =>
      state = AuthState(me: await _repo.register(fullName: fullName, username: username, email: email, password: password), restoring: false);

  /// Re-reads the profile from the server (the server is the only authority on KYC/status).
  Future<void> refreshMe() async => state = AuthState(me: await _repo.me(), restoring: false);

  Future<void> logout() async {
    await _repo.logout();
    ref.read(lockProvider.notifier).unlock();
    await ref.read(settingsProvider.notifier).clearCustomerPrefs();
    state = const AuthState(restoring: false);
  }
}

final authControllerProvider = NotifierProvider<AuthController, AuthState>(AuthController.new);
