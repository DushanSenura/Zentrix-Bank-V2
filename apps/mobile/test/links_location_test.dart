import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/core/platform/platform_services.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/support/presentation/support_pages.dart';

import 'fake_api.dart';
import 'harness.dart';

class RecordingLauncher implements LinkLauncher {
  final opened = <Uri>[];
  bool ok = true;
  @override
  Future<bool> open(Uri uri) async { opened.add(uri); return ok; }
}

class FakeLocation implements LocationService {
  FakeLocation({this.fail});
  final Exception? fail;
  @override
  Future<Coordinates> current() async { if (fail != null) throw fail!; return const Coordinates(6.93, 79.85); }
}

Widget app(FakeApi api, Widget page, {RecordingLauncher? launcher, LocationService? location}) => ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(api),
        if (launcher != null) linkLauncherProvider.overrideWithValue(launcher),
        if (location != null) locationServiceProvider.overrideWithValue(location),
      ],
      child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => page)])),
    );

Map<String, dynamic> branch(String id, String name, {double? distance}) => {'id': id, 'name': name, 'city': 'Colombo', 'address': '1 Main St', 'type': 'BRANCH', 'phone': '+94 11 234 5678', 'hours': 'Mon-Fri 9-4', 'latitude': 6.9344, 'longitude': 79.8428, 'distanceKm': distance};

void main() {
  test('link builders produce the right schemes and strip formatting', () {
    expect(phoneUri('+94 11 234-5678').toString(), 'tel:+94112345678');
    expect(emailUri('a@b.test', subject: 'Hi there').toString(), 'mailto:a@b.test?subject=Hi%20there');
    expect(mapsUri(6.93, 79.85).toString(), startsWith('https://www.google.com/maps/search/?api=1&query=6.93'));
  });

  testWidgets('the help hub offers the helpline and email, opened by the phone\'s own apps', (t) async {
    tallScreen(t);
    final launcher = RecordingLauncher();
    final api = FakeApi((p, q, b) => p == '/api/v1/support/faqs' ? {'items': []} : {});
    await t.pumpWidget(app(api, const SupportHubPage(), launcher: launcher));
    await t.pumpAndSettle();
    await t.tap(find.text('Call the helpline'));
    await t.tap(find.text('Email support'));
    await t.pumpAndSettle();
    expect(launcher.opened.map((u) => u.scheme), ['tel', 'mailto']);
    expect(launcher.opened.first.path, '+94110000000');
    expect(find.text('Fictional contact details for this simulation.'), findsOneWidget);
  });

  testWidgets('branches can be called and navigated to, and a phone without the app gets a clear message', (t) async {
    tallScreen(t);
    final launcher = RecordingLauncher();
    final api = FakeApi((p, q, b) => p == '/api/v1/branches' ? {'items': [branch('b1', 'Colombo Fort')]} : {});
    await t.pumpWidget(app(api, const BranchesPage(), launcher: launcher));
    await t.pumpAndSettle();
    await t.tap(find.text('Call Colombo Fort'));
    await t.tap(find.text('Directions to Colombo Fort'));
    await t.pumpAndSettle();
    expect(launcher.opened.first.toString(), 'tel:+94112345678');
    expect(launcher.opened.last.host, 'www.google.com');
    expect(launcher.opened.last.queryParameters['query'], contains('6.9344,79.8428'));

    launcher.ok = false;
    await t.tap(find.text('Call Colombo Fort'));
    await t.pumpAndSettle();
    expect(find.text('Your phone has no app to open that.'), findsOneWidget);
  });

  testWidgets('"Near me" asks for location only when tapped, sends coordinates to the bank and shows distances', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => p == '/api/v1/branches' ? {'items': [branch('b1', 'Colombo Fort', distance: 0.9)]} : {});
    await t.pumpWidget(app(api, const BranchesPage(), location: FakeLocation()));
    await t.pumpAndSettle();
    expect(api.where('GET', '/api/v1/branches').every((r) => !r.query!.containsKey('lat')), isTrue); // not asked at page open
    await t.tap(find.text('Near me'));
    await t.pumpAndSettle();
    final q = api.where('GET', '/api/v1/branches').last.query!;
    expect(q['lat'], 6.93);
    expect(q['lng'], 79.85);
    expect(find.textContaining('0.9 km away'), findsOneWidget);
    await t.tap(find.text('Near me')); // off again
    await t.pumpAndSettle();
    expect(api.where('GET', '/api/v1/branches').last.query!.containsKey('lat'), isFalse);
  });

  testWidgets('a refused location permission is explained and the city search still works', (t) async {
    tallScreen(t);
    final api = FakeApi((p, q, b) => p == '/api/v1/branches' ? {'items': [branch('b1', 'Colombo Fort')]} : {});
    await t.pumpWidget(app(api, const BranchesPage(), location: FakeLocation(fail: LocationDenied('Location permission was not given. You can still search by city.'))));
    await t.pumpAndSettle();
    await t.tap(find.text('Near me'));
    await t.pumpAndSettle();
    expect(find.textContaining('Location permission was not given'), findsOneWidget);
    expect(find.text('Colombo Fort'), findsOneWidget);
  });
}
