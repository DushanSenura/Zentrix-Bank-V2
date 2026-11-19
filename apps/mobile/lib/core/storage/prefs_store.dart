import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Small key/value store for NON-secret device preferences (still kept in the secure store: it is already
/// available and avoids another plugin). Nothing sensitive such as passwords or PINs is ever written here.
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
