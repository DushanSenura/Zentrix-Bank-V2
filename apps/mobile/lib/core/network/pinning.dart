import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:dio/io.dart';

/// Optional certificate pinning, enabled by building with `--dart-define=API_PINS=<hex>,<backup-hex>`: lower-case SHA-256 of the
/// server certificate in DER form. Always include a backup pin, or a certificate renewal locks every installed app out.
class PinPolicy {
  PinPolicy._(this.pins);
  final Set<String> pins;

  /// Parses a comma-separated list. Entries that are not 64 hex characters are ignored, so a typo can never silently weaken a pin set
  /// into "match anything" (an empty result means pinning is OFF, which [enabled] reports honestly).
  factory PinPolicy.parse(String raw) {
    final ok = RegExp(r'^[0-9a-f]{64}$');
    return PinPolicy._({for (final p in raw.split(',')) if (ok.hasMatch(p.trim().toLowerCase())) p.trim().toLowerCase()});
  }

  bool get enabled => pins.isNotEmpty;

  bool matches(Uint8List derCertificate) => pins.contains(sha256.convert(derCertificate).toString());
}

const _rawPins = String.fromEnvironment('API_PINS');
final PinPolicy apiPins = PinPolicy.parse(_rawPins);

/// Applies pinning to [dio] when pins are configured. Plain-HTTP development servers are left alone (there is no certificate to pin).
void applyPinning(Dio dio, {PinPolicy? policy, required String baseUrl}) {
  final p = policy ?? apiPins;
  if (!p.enabled || !baseUrl.startsWith('https://')) return;
  dio.httpClientAdapter = IOHttpClientAdapter(
    validateCertificate: (cert, host, port) => cert != null && p.matches(cert.der), // refuse when absent or not pinned
  );
}
