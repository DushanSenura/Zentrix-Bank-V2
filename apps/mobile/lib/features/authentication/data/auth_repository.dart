import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/storage/prefs_store.dart';
import '../../../core/storage/token_store.dart';
import '../../support/data/support_repository.dart' show DownloadedFile;

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

class SessionInfo {
  const SessionInfo({required this.id, required this.createdAt, required this.current, this.userAgent, this.ip});
  final String id;
  final DateTime createdAt;
  final bool current;
  final String? userAgent;
  final String? ip;
}

class LoginEntry {
  const LoginEntry({required this.at, required this.success, this.ip});
  final DateTime at;
  final bool success;
  final String? ip;
}

class DeviceInfo {
  const DeviceInfo({required this.id, required this.trustedAt, this.label});
  final String id;
  final DateTime trustedAt;
  final String? label;
}

/// A fictional seeded customer offered on the sign-in screen of DEBUG builds only.
class DemoAccount {
  const DemoAccount({required this.username, required this.password, required this.fullName, this.pin});
  final String username;
  final String password;
  final String fullName;
  final String? pin;
}

class AuthRepository {
  AuthRepository(this._dio, this._store, [this._prefs]);
  final Dio _dio;
  final TokenStore _store;
  final PrefsStore? _prefs;
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
        (d['code'] as String?) ?? (s == 401 ? 'unauthenticated' : 'error'),
        s >= 500 ? 'Something went wrong on our side. Please try again.' : (d['message'] as String?) ?? 'Request failed',
        fields: ((d['fields'] as Map?) ?? const {}).map((k, v) => MapEntry('$k', '$v')),
      );
    } on DioException {
      // A dropped connection is NOT a business refusal - callers must not assume a write failed.
      throw ApiFailure('network', 'Cannot reach Zentrix Bank. Check your connection and try again.', network: true);
    }
  }

  /// Authenticated call: on 401 refreshes the token once and replays. (Money-moving calls arrive later and must
  /// carry an idempotency key before they are ever replayed.)
  Future<Response<Map<String, dynamic>>> _authed(Future<Response<Map<String, dynamic>>> Function(Options o) call) async {
    return _send(() async {
      var r = await call(_auth);
      // Refresh ONLY when the access token expired. A 401 for a wrong PIN/password must never be replayed:
      // that would silently double-count failed attempts toward the lockout.
      if (r.statusCode == 401 && _isTokenExpiry(r.data) && await _refreshOnce()) r = await call(_auth);
      return r;
    });
  }

  static bool _isTokenExpiry(Map<String, dynamic>? d) {
    final c = d?['code'];
    return c == 'unauthenticated' || c == 'session_expired';
  }

  Future<void> _adopt(Map<String, dynamic> d) async {
    _access = d['accessToken'] as String;
    _refresh = d['refreshToken'] as String;
  }

  Future<Me> login(String identifier, String password, {bool remember = false}) async {
    final r = await _send(() => _dio.post('/api/v1/auth/login', data: {'identifier': identifier, 'password': password}));
    if (r.data!['userType'] != 'CUSTOMER') throw ApiFailure('not_customer', 'Please use the Zentrix staff portal to sign in.');
    await _adopt(r.data!);
    if (remember) {
      await _store.writeRefresh(_refresh!);
      await _trustThisDevice();
    }
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

  /// Authenticated JSON helpers for feature repositories (token refresh handled here, in one place).
  Future<Map<String, dynamic>> getJson(String path, {Map<String, dynamic>? query}) async =>
      (await _authed((o) => _dio.get(path, options: o, queryParameters: query))).data ?? const {};
  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body, {Map<String, String>? headers}) async =>
      (await _authed((o) => _dio.post(path, options: o.copyWith(headers: {...?o.headers, ...?headers}), data: body))).data ?? const {};
  Future<Map<String, dynamic>> putJson(String path, Map<String, dynamic> body) async =>
      (await _authed((o) => _dio.put(path, options: o, data: body))).data ?? const {};
  /// Development helper: the API answers 404 anywhere except a local development server, and this returns an empty list then.
  Future<List<DemoAccount>> demoAccounts() async {
    try {
      final r = await _dio.get<Map<String, dynamic>>('/api/v1/dev/demo-accounts');
      if (r.statusCode != 200) return const [];
      return [
        for (final a in ((r.data?['accounts'] as List?) ?? const []).cast<Map<String, dynamic>>())
          if (a['kind'] == 'CUSTOMER') DemoAccount(username: a['username'] as String, password: a['password'] as String, fullName: a['fullName'] as String, pin: a['pin'] as String?),
      ];
    } catch (_) {
      return const [];
    }
  }

  /// Binary download (statements, receipts). Same refresh and error rules as the JSON helpers.
  Future<DownloadedFile> getFile(String path, {Map<String, dynamic>? query}) async {
    Future<Response<List<int>>> call() => _dio.get<List<int>>(path, queryParameters: query, options: _auth.copyWith(responseType: ResponseType.bytes));
    try {
      var r = await call();
      if (r.statusCode == 401 && await _refreshOnce()) r = await call();
      final s = r.statusCode ?? 0;
      final bytes = Uint8List.fromList(r.data ?? const <int>[]);
      if (s < 200 || s >= 300) {
        Map<String, dynamic> d = const {};
        try { d = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>; } catch (_) {}
        throw ApiFailure((d['code'] as String?) ?? 'error', s >= 500 ? 'Something went wrong on our side. Please try again.' : (d['message'] as String?) ?? 'Request failed');
      }
      final cd = r.headers.value('content-disposition') ?? '';
      final name = RegExp('filename="([^"]+)"').firstMatch(cd)?.group(1) ?? 'zentrix-document';
      return DownloadedFile(bytes, name, r.headers.value('content-type') ?? 'application/octet-stream');
    } on DioException {
      throw ApiFailure('network', 'Cannot reach Zentrix Bank. Check your connection and try again.', network: true);
    }
  }

  Future<void> deleteJson(String path) => _authed((o) => _dio.delete(path, options: o));

  Future<Me> me() async => Me.fromJson((await _authed((o) => _dio.get('/api/v1/me', options: o))).data!);

  Future<bool> _refreshOnce() async {
    if (_refresh == null) return false;
    final r = await _dio.post<Map<String, dynamic>>('/api/v1/auth/refresh', data: {'refreshToken': _refresh});
    if (r.statusCode != 200) return false;
    await _adopt(r.data!);
    if (await _store.readRefresh() != null) await _store.writeRefresh(_refresh!);
    return true;
  }

  Future<void> submitKyc({required String nationalId, required String dateOfBirth, required String line1, required String city, required String postalCode}) =>
      _authed((o) => _dio.post('/api/v1/me/kyc', options: o, data: {
            'nationalId': nationalId,
            'dateOfBirth': dateOfBirth,
            'address': {'line1': line1, 'city': city, 'postalCode': postalCode},
          }));

  Future<void> setPin(String pin) => _authed((o) => _dio.put('/api/v1/me/pin', options: o, data: {'pin': pin}));
  Future<void> changePin(String currentPin, String newPin) =>
      _authed((o) => _dio.put('/api/v1/security/pin', options: o, data: {'currentPin': currentPin, 'newPin': newPin}));
  Future<void> verifyPin(String pin) => _authed((o) => _dio.post('/api/v1/security/pin/verify', options: o, data: {'pin': pin}));
  Future<void> changePassword(String current, String next) =>
      _authed((o) => _dio.put('/api/v1/security/password', options: o, data: {'current': current, 'next': next}));

  Future<List<SessionInfo>> sessions() async {
    final d = (await _authed((o) => _dio.get('/api/v1/security/sessions', options: o))).data!;
    return [
      for (final s in (d['items'] as List).cast<Map<String, dynamic>>())
        SessionInfo(id: s['id'] as String, createdAt: DateTime.parse(s['createdAt'] as String), current: s['current'] == true, userAgent: s['userAgent'] as String?, ip: s['ip'] as String?),
    ];
  }

  Future<void> revokeSession(String id) => _authed((o) => _dio.delete('/api/v1/security/sessions/$id', options: o));
  Future<void> revokeOtherSessions() => _authed((o) => _dio.post('/api/v1/security/sessions/revoke-others', options: o));

  Future<List<LoginEntry>> loginHistory() async {
    final d = (await _authed((o) => _dio.get('/api/v1/security/login-history', options: o))).data!;
    return [for (final h in (d['items'] as List).cast<Map<String, dynamic>>()) LoginEntry(at: DateTime.parse(h['at'] as String), success: h['success'] == true, ip: h['ip'] as String?)];
  }

  Future<List<DeviceInfo>> devices() async {
    final d = (await _authed((o) => _dio.get('/api/v1/security/devices', options: o))).data!;
    return [for (final x in (d['items'] as List).cast<Map<String, dynamic>>()) DeviceInfo(id: x['id'] as String, trustedAt: DateTime.parse(x['trustedAt'] as String), label: x['label'] as String?)];
  }

  Future<void> removeDevice(String id) => _authed((o) => _dio.delete('/api/v1/security/devices/$id', options: o));

  /// Random per-install id (not hardware-derived, so it carries no personal data).
  Future<String> _deviceId() async {
    final p = _prefs;
    if (p == null) return 'unknown-device-0000';
    var id = await p.read('deviceId');
    if (id == null) {
      final r = Random.secure();
      id = List.generate(24, (_) => r.nextInt(16).toRadixString(16)).join();
      await p.write('deviceId', id);
    }
    return id;
  }

  Future<void> _trustThisDevice() async {
    try {
      await _authed(
          (o) async => _dio.post('/api/v1/security/devices', options: o, data: {'fingerprint': await _deviceId(), 'label': 'This device'}));
    } on ApiFailure {
      // Best effort: "remember this device" must not block sign-in.
    }
  }

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

final authRepositoryProvider = Provider<AuthRepository>((ref) => AuthRepository(ref.watch(dioProvider), ref.watch(tokenStoreProvider), ref.watch(prefsStoreProvider)));
