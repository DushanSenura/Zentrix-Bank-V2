import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/storage/token_store.dart';

/// Customer-safe failure. Never carries URLs, headers or raw server text beyond the API's own message.
class ApiFailure implements Exception {
  ApiFailure(this.code, this.message, {this.fields = const {}, this.network = false});
  final String code;
  final String message;
  final Map<String, String> fields;
  final bool network;
  @override
  String toString() => message;
}

class Me {
  const Me({required this.id, required this.fullName, required this.status, required this.kycStatus, required this.hasPin, this.customerNumber, this.kycNote});
  final String id;
  final String fullName;
  final String status; // PENDING_VERIFICATION | ACTIVE | ...
  final String kycStatus; // NOT_SUBMITTED | SUBMITTED | MORE_INFO_REQUESTED | APPROVED | REJECTED
  final bool hasPin;
  final String? customerNumber;
  final String? kycNote;

  factory Me.fromJson(Map<String, dynamic> j) => Me(
        id: j['id'] as String,
        fullName: (j['fullName'] as String?) ?? (j['username'] as String),
        status: j['status'] as String,
        kycStatus: (j['kycStatus'] as String?) ?? 'NOT_SUBMITTED',
        hasPin: j['hasPin'] == true,
        customerNumber: j['customerNumber'] as String?,
        kycNote: j['kycNote'] as String?,
      );
}

class AuthRepository {
  AuthRepository(this._dio, this._store);
  final Dio _dio;
  final TokenStore _store;
  String? _access;
  String? _refresh;

  Options get _auth => Options(headers: {'Authorization': 'Bearer $_access'});

  Future<Response<Map<String, dynamic>>> _send(Future<Response<Map<String, dynamic>>> Function() call) async {
    try {
      final r = await call();
      final s = r.statusCode ?? 0;
      if (s >= 200 && s < 300) return r;
      final d = r.data ?? const {};
      throw ApiFailure(
        (d['code'] as String?) ?? 'error',
        s >= 500 ? 'Something went wrong on our side. Please try again.' : (d['message'] as String?) ?? 'Request failed',
        fields: ((d['fields'] as Map?) ?? const {}).map((k, v) => MapEntry('$k', '$v')),
      );
    } on DioException {
      // A dropped connection is NOT a business refusal - callers must not assume a write failed.
      throw ApiFailure('network', 'Cannot reach Zentrix Bank. Check your connection and try again.', network: true);
    }
  }

  Future<void> _adopt(Map<String, dynamic> d) async {
    _access = d['accessToken'] as String;
    _refresh = d['refreshToken'] as String;
  }

  Future<Me> login(String identifier, String password, {bool remember = false}) async {
    final r = await _send(() => _dio.post('/api/v1/auth/login', data: {'identifier': identifier, 'password': password}));
    if (r.data!['userType'] != 'CUSTOMER') throw ApiFailure('not_customer', 'Please use the Zentrix staff portal to sign in.');
    await _adopt(r.data!);
    if (remember) await _store.writeRefresh(_refresh!);
    return me();
  }

  Future<Me> register({required String fullName, required String username, required String email, required String password}) async {
    final r = await _send(() => _dio.post('/api/v1/auth/register', data: {'fullName': fullName, 'username': username, 'email': email, 'password': password}));
    await _adopt(r.data!);
    return me();
  }

  /// Restores a remembered session. Returns null if there is none or it is no longer valid.
  Future<Me?> restore() async {
    final saved = await _store.readRefresh();
    if (saved == null) return null;
    try {
      final r = await _send(() => _dio.post('/api/v1/auth/refresh', data: {'refreshToken': saved}));
      await _adopt(r.data!);
      await _store.writeRefresh(_refresh!);
      return me();
    } on ApiFailure catch (e) {
      if (!e.network) await _store.clear();
      return null;
    }
  }

  Future<Me> me() async {
    Future<Response<Map<String, dynamic>>> call() => _dio.get('/api/v1/me', options: _auth);
    var r = await call();
    if (r.statusCode == 401 && await _refreshOnce()) r = await call();
    return Me.fromJson((await _send(() async => r)).data!);
  }

  Future<bool> _refreshOnce() async {
    if (_refresh == null) return false;
    final r = await _dio.post<Map<String, dynamic>>('/api/v1/auth/refresh', data: {'refreshToken': _refresh});
    if (r.statusCode != 200) return false;
    await _adopt(r.data!);
    if (await _store.readRefresh() != null) await _store.writeRefresh(_refresh!);
    return true;
  }

  Future<void> submitKyc({required String nationalId, required String dateOfBirth, required String line1, required String city, required String postalCode}) =>
      _send(() => _dio.post('/api/v1/me/kyc', options: _auth, data: {
            'nationalId': nationalId,
            'dateOfBirth': dateOfBirth,
            'address': {'line1': line1, 'city': city, 'postalCode': postalCode},
          }));

  Future<void> setPin(String pin) => _send(() => _dio.put('/api/v1/me/pin', options: _auth, data: {'pin': pin}));

  Future<void> requestPasswordReset(String identifier) =>
      _send(() => _dio.post('/api/v1/auth/password-reset/request', data: {'identifier': identifier}));

  Future<void> confirmPasswordReset(String token, String newPassword) =>
      _send(() => _dio.post('/api/v1/auth/password-reset/confirm', data: {'token': token, 'newPassword': newPassword}));

  Future<void> logout() async {
    try {
      if (_access != null) await _dio.post('/api/v1/auth/logout', options: _auth);
    } on DioException {
      // Local sign-out must still succeed offline; the server session expires on its own.
    }
    _access = null;
    _refresh = null;
    await _store.clear();
  }
}

final authRepositoryProvider = Provider<AuthRepository>((ref) => AuthRepository(ref.watch(dioProvider), ref.watch(tokenStoreProvider)));
