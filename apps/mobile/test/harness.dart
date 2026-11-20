import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:zentrix_bank/core/design_system/app_theme.dart';
import 'package:zentrix_bank/core/storage/prefs_store.dart';
import 'package:zentrix_bank/features/authentication/data/auth_repository.dart';
import 'package:zentrix_bank/features/support/data/file_sharer.dart';

import 'package:flutter_test/flutter_test.dart';

import 'fake_api.dart';

/// A phone-sized viewport tall enough that long lists build every row (lazy lists only build what fits).
void tallScreen(WidgetTester t) {
  t.view.physicalSize = const Size(390 * 3, 1800 * 3);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
}

/// Mounts one page inside a real router (so context.push/go work) with the app theme. Extra routes are simple stubs.
Widget pageHarness(FakeApi api, Widget page, {RecordingSharer? sharer, Map<String, String> stubs = const {}, bool dark = false}) {
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => page),
    for (final e in stubs.entries) GoRoute(path: e.key, builder: (_, _) => Scaffold(body: Text(e.value))),
  ]);
  return ProviderScope(
    overrides: [
      authRepositoryProvider.overrideWithValue(api),
      prefsStoreProvider.overrideWithValue(MemoryPrefsStore()),
      if (sharer != null) fileSharerProvider.overrideWithValue(sharer),
    ],
    child: MaterialApp.router(theme: buildTheme(dark ? Brightness.dark : Brightness.light), routerConfig: router),
  );
}
