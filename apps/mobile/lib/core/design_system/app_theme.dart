import 'package:flutter/material.dart';

import 'tokens.dart';

/// Pages fade in and rise a few pixels; with reduce-motion on they simply appear.
class ZxPageTransitions extends PageTransitionsBuilder {
  const ZxPageTransitions();
  @override
  Widget buildTransitions<T>(PageRoute<T> route, BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation, Widget child) {
    if (MediaQuery.of(context).disableAnimations) return child;
    final curved = CurvedAnimation(parent: animation, curve: ZxMotion.curve);
    return FadeTransition(opacity: curved, child: SlideTransition(position: Tween(begin: const Offset(0, 0.03), end: Offset.zero).animate(curved), child: child));
  }
}

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
    pageTransitionsTheme: const PageTransitionsTheme(builders: {TargetPlatform.android: ZxPageTransitions(), TargetPlatform.iOS: ZxPageTransitions(), TargetPlatform.windows: ZxPageTransitions(), TargetPlatform.macOS: ZxPageTransitions(), TargetPlatform.linux: ZxPageTransitions()}),
    // Sheets are frosted glass: a see-through surface with rounded top corners.
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: scheme.surface.withValues(alpha: 0.94), modalBackgroundColor: scheme.surface.withValues(alpha: 0.94), showDragHandle: true, clipBehavior: Clip.antiAlias, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(ZxSpace.radius)))),
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
