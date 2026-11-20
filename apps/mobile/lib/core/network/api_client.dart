import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/api_config.dart';
import 'pinning.dart';

final dioProvider = Provider<Dio>((ref) {
  final dio = Dio(BaseOptions(
    baseUrl: ApiConfig.baseUrl,
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 10),
    validateStatus: (s) => s != null && s < 600,
  ));
  applyPinning(dio, baseUrl: ApiConfig.baseUrl); // no-op unless built with API_PINS
  return dio;
});
