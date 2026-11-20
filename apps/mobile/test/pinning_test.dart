import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/core/network/pinning.dart';

void main() {
  final der = Uint8List.fromList(List.generate(64, (i) => i));
  final pin = sha256.convert(der).toString();

  test('a pin set matches only the exact certificate hash, case-insensitively, with backups', () {
    final p = PinPolicy.parse('${pin.toUpperCase()}, ${'a' * 64}');
    expect(p.enabled, isTrue);
    expect(p.pins, hasLength(2));
    expect(p.matches(der), isTrue);
    expect(p.matches(Uint8List.fromList([...der, 1])), isFalse);
  });

  test('malformed entries are dropped; if none are valid pinning reports itself OFF instead of matching anything', () {
    expect(PinPolicy.parse('').enabled, isFalse);
    expect(PinPolicy.parse('not-hex, 1234').enabled, isFalse);
    final p = PinPolicy.parse('xyz,$pin');
    expect(p.pins, {pin});
  });

  test('pinning is applied to https servers only, and only when configured', () {
    final on = PinPolicy.parse(pin);
    final https = Dio();
    applyPinning(https, policy: on, baseUrl: 'https://api.example.test');
    expect(https.httpClientAdapter, isA<IOHttpClientAdapter>());

    final http = Dio();
    final before = http.httpClientAdapter;
    applyPinning(http, policy: on, baseUrl: 'http://10.0.2.2:3000'); // local dev: nothing to pin
    expect(identical(http.httpClientAdapter, before), isTrue);

    final off = Dio();
    final offBefore = off.httpClientAdapter;
    applyPinning(off, policy: PinPolicy.parse(''), baseUrl: 'https://api.example.test');
    expect(identical(off.httpClientAdapter, offBefore), isTrue);
  });
}
