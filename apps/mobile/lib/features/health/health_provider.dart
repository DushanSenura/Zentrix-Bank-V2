import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';

class ServiceHealth {
  const ServiceHealth({required this.ok, required this.database, required this.redis});
  final bool ok;
  final bool database;
  final bool redis;
}

/// Reads API readiness. Throws on network failure so the UI can show a real error state.
final healthProvider = FutureProvider.autoDispose<ServiceHealth>((ref) async {
  final res = await ref.watch(dioProvider).get<Map<String, dynamic>>('/api/v1/health');
  final raw = res.data ?? const {};
  final body = (raw['checks'] != null ? raw : raw['message']) as Map<String, dynamic>? ?? const {};
  final checks = (body['checks'] as Map<String, dynamic>?) ?? const {};
  bool up(String k) => (checks[k] as Map<String, dynamic>?)?['status'] == 'up';
  return ServiceHealth(ok: body['status'] == 'ok', database: up('database'), redis: up('redis'));
});
