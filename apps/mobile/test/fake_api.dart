import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/core/security/biometric_service.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';

typedef Handler = Map<String, dynamic> Function(String path, Map<String, dynamic>? query, Map<String, dynamic>? body);

class Req {
  Req(this.method, this.path, this.query, this.body, this.headers);
  final String method;
  final String path;
  final Map<String, dynamic>? query;
  final Map<String, dynamic>? body;
  final Map<String, String>? headers;
}

/// In-memory stand-in for the authenticated API client. Records every request so tests can assert on
/// exactly what the app sent (bodies and Idempotency-Key headers).
class FakeApi implements AuthRepository {
  FakeApi(this.handler);
  final Handler handler;
  final requests = <Req>[];
  static const active = Me(id: '1', fullName: 'Amaya Perera', status: 'ACTIVE', kycStatus: 'APPROVED', hasPin: false, customerNumber: 'ZB90000001');

  Iterable<Req> where(String method, String path) => requests.where((r) => r.method == method && r.path == path);

  @override
  Future<Me?> restore() async => active;
  @override
  Future<Map<String, dynamic>> getJson(String path, {Map<String, dynamic>? query}) async {
    requests.add(Req('GET', path, query, null, null));
    return handler(path, query, null);
  }

  @override
  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body, {Map<String, String>? headers}) async {
    requests.add(Req('POST', path, null, body, headers));
    return handler(path, null, body);
  }

  @override
  Future<Map<String, dynamic>> putJson(String path, Map<String, dynamic> body) async {
    requests.add(Req('PUT', path, null, body, null));
    return handler(path, null, body);
  }

  @override
  Future<void> deleteJson(String path) async {
    requests.add(Req('DELETE', path, null, null, null));
    handler(path, null, null);
  }

  @override
  Future<void> logout() async {}
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

class NoBio implements BiometricService {
  @override
  Future<bool> available() async => false;
  @override
  Future<bool> authenticate(String reason) async => false;
}

Map<String, dynamic> acct(String id, String name, int bal, {String status = 'ACTIVE'}) => {
      'id': id, 'accountNumberMasked': '*******1234', 'nickname': name, 'productName': 'Savings Account', 'productCode': 'SAVINGS_STD', 'kind': 'SAVINGS',
      'interestRateBps': 350, 'currency': 'LKR', 'status': status, 'openedAt': '2026-01-01T00:00:00Z', 'balanceMinor': bal,
    };

Widget appWith(FakeApi api) => ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(api),
        prefsStoreProvider.overrideWithValue(MemoryPrefsStore()..data['onboarded'] = '1'),
        biometricServiceProvider.overrideWithValue(NoBio()),
      ],
      child: const ZentrixApp(),
    );
