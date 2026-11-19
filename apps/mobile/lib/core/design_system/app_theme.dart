import 'package:flutter/material.dart';

import 'tokens.dart';

ThemeData buildTheme(Brightness b) {
  final z = b == Brightness.light ? ZxColors.light : ZxColors.dark;
  final scheme = ColorScheme.fromSeed(seedColor: z.primary, brightness: b).copyWith(primary: z.primary, error: z.error);
  return ThemeData(
    useMaterial3: true,
    fontFamily: 'Manrope',
    brightness: b,
    colorScheme: scheme,
    scaffoldBackgroundColor: z.background,
    extensions: [z],
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: z.glass,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(ZxSpace.radiusSm), borderSide: BorderSide(color: z.glassBorder)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: z.primary,
        foregroundColor: b == Brightness.light ? Colors.white : z.navy,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(ZxSpace.radiusSm)),
        textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
      ),
    ),
  );
}
