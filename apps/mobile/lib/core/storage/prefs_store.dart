import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Small key/value store for NON-secret device preferences (still kept in the secure store: it is already
/// available and avoids another plugin). Passwords are never written here. The ONE exception is the app PIN, kept only if the
/// customer opts in to approving payments with biometrics (see [payPinKey]); it stays in the OS secure store, is removed on
/// sign-out, PIN change and when the option is turned off, and the bank still verifies it on every payment.
/// Key of the opt-in biometric payment PIN. Do not use for anything else.
const payPinKey = 'payPin';

abstract class PrefsStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecurePrefsStore implements PrefsStore {
  SecurePrefsStore([FlutterSecureStorage? s]) : _s = s ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  @override
  Future<String?> read(String key) => _s.read(key: 'pref.$key');
  @override
  Future<void> write(String key, String value) => _s.write(key: 'pref.$key', value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: 'pref.$key');
}

class MemoryPrefsStore implements PrefsStore {
  final Map<String, String> data = {};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}

final prefsStoreProvider = Provider<PrefsStore>((_) => SecurePrefsStore());
