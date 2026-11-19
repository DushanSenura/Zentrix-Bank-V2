import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/storage/prefs_store.dart';

class Settings {
  const Settings({this.onboarded = false, this.biometric = false, this.lockMinutes = 2, this.reduceMotion = false, this.themeMode = ThemeMode.system, this.hideBalances = false});
  final bool onboarded;
  final bool biometric;
  final int lockMinutes; // 0 = lock whenever the app is backgrounded
  final bool reduceMotion;
  final ThemeMode themeMode;
  final bool hideBalances;

  Settings copyWith({bool? onboarded, bool? biometric, int? lockMinutes, bool? reduceMotion, ThemeMode? themeMode, bool? hideBalances}) => Settings(
        onboarded: onboarded ?? this.onboarded,
        biometric: biometric ?? this.biometric,
        lockMinutes: lockMinutes ?? this.lockMinutes,
        reduceMotion: reduceMotion ?? this.reduceMotion,
        themeMode: themeMode ?? this.themeMode,
        hideBalances: hideBalances ?? this.hideBalances,
      );
}

class SettingsController extends Notifier<Settings> {
  PrefsStore get _p => ref.read(prefsStoreProvider);

  @override
  Settings build() => const Settings();

  Future<void> load() async {
    final theme = await _p.read('theme');
    state = Settings(
      onboarded: await _p.read('onboarded') == '1',
      biometric: await _p.read('biometric') == '1',
      lockMinutes: int.tryParse(await _p.read('lockMinutes') ?? '') ?? 2,
      reduceMotion: await _p.read('reduceMotion') == '1',
      hideBalances: await _p.read('hideBalances') == '1',
      themeMode: ThemeMode.values.firstWhere((m) => m.name == theme, orElse: () => ThemeMode.system),
    );
  }

  Future<void> markOnboarded() async { state = state.copyWith(onboarded: true); await _p.write('onboarded', '1'); }
  Future<void> setBiometric(bool v) async { state = state.copyWith(biometric: v); await _p.write('biometric', v ? '1' : '0'); }
  Future<void> setLockMinutes(int m) async { state = state.copyWith(lockMinutes: m); await _p.write('lockMinutes', '$m'); }
  Future<void> setReduceMotion(bool v) async { state = state.copyWith(reduceMotion: v); await _p.write('reduceMotion', v ? '1' : '0'); }
  Future<void> setHideBalances(bool v) async { state = state.copyWith(hideBalances: v); await _p.write('hideBalances', v ? '1' : '0'); }
  Future<void> setTheme(ThemeMode m) async { state = state.copyWith(themeMode: m); await _p.write('theme', m.name); }

  /// Customer-specific choices must not leak to the next person on a shared device.
  Future<void> clearCustomerPrefs() async {
    state = state.copyWith(biometric: false);
    await _p.delete('biometric');
  }
}

final settingsProvider = NotifierProvider<SettingsController, Settings>(SettingsController.new);
