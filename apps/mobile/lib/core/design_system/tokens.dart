import 'package:flutter/material.dart';

/// Zentrix V2 design tokens. Colours are a ThemeExtension (`context.zx`) with light and dark palettes.
@immutable
class ZxColors extends ThemeExtension<ZxColors> {
  const ZxColors({
    required this.primary,
    required this.navy,
    required this.cyan,
    required this.background,
    required this.glass,
    required this.glassBorder,
    required this.text,
    required this.textMuted,
    required this.success,
    required this.warning,
    required this.error,
  });

  final Color primary, navy, cyan, background, glass, glassBorder, text, textMuted, success, warning, error;

  static const light = ZxColors(
    primary: Color(0xFF155EEF),
    navy: Color(0xFF071B45),
    cyan: Color(0xFF39C7F4),
    background: Color(0xFFF5F8FF),
    glass: Color(0xB3FFFFFF),
    glassBorder: Color(0x33FFFFFF),
    text: Color(0xFF0B1B3B),
    textMuted: Color(0xFF4A5876),
    success: Color(0xFF0E7F5E),
    warning: Color(0xFF8A5A00),
    error: Color(0xFFC02D3D),
  );

  static const dark = ZxColors(
    primary: Color(0xFF5B8DFF),
    navy: Color(0xFF071B45),
    cyan: Color(0xFF39C7F4),
    background: Color(0xFF07111F),
    glass: Color(0xB3132540),
    glassBorder: Color(0x22FFFFFF),
    text: Color(0xFFEAF1FF),
    textMuted: Color(0xFFA6B6D6),
    success: Color(0xFF3DD6A5),
    warning: Color(0xFFF0B861),
    error: Color(0xFFFF8592),
  );

  @override
  ZxColors copyWith({Color? primary}) => ZxColors(
        primary: primary ?? this.primary,
        navy: navy,
        cyan: cyan,
        background: background,
        glass: glass,
        glassBorder: glassBorder,
        text: text,
        textMuted: textMuted,
        success: success,
        warning: warning,
        error: error,
      );

  @override
  ZxColors lerp(ThemeExtension<ZxColors>? other, double t) => t < 0.5 ? this : (other as ZxColors? ?? this);
}

extension ZxContext on BuildContext {
  ZxColors get zx => Theme.of(this).extension<ZxColors>()!;
}

/// Spacing / radius tokens.
class ZxSpace {
  static const xs = 4.0, sm = 8.0, md = 16.0, lg = 24.0, xl = 32.0;
  static const radius = 20.0, radiusSm = 12.0;
}

/// Motion tokens (durations from the V2 brief). Honour the OS reduce-motion setting via [scaled].
class ZxMotion {
  static const micro = Duration(milliseconds: 140);
  static const standard = Duration(milliseconds: 240);
  static const page = Duration(milliseconds: 320);
  static const large = Duration(milliseconds: 450);
  static const curve = Curves.easeOutCubic;

  static bool reduced(BuildContext context) => MediaQuery.of(context).disableAnimations;

  static Duration scaled(BuildContext context, Duration d) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : d;
}
