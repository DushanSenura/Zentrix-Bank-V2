import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists ONLY the refresh token (Keystore/Keychain via flutter_secure_storage).
/// The access token lives in memory; passwords and PINs are never stored on the device.
abstract class TokenStore {
  Future<String?> readRefresh();
  Future<void> writeRefresh(String token);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? s]) : _s = s ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  static const _k = 'zx.refresh';

  @override
  Future<String?> readRefresh() => _s.read(key: _k);
  @override
  Future<void> writeRefresh(String token) => _s.write(key: _k, value: token);
  @override
  Future<void> clear() => _s.delete(key: _k);
}

final tokenStoreProvider = Provider<TokenStore>((_) => SecureTokenStore());
