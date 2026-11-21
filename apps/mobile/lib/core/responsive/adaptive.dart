import 'package:flutter/material.dart';

/// Width classes taken from the space a widget is actually given (not from the device type).
enum ScreenClass {
  compact, // under 360 dp
  standard, // 360 to 599
  large, // 600 to 839: large phone or small tablet
  expanded; // 840 and up

  static ScreenClass of(double width) => width < 360 ? compact : width < 600 ? standard : width < 840 ? large : expanded;

  /// Side margin for page content.
  double get gutter => switch (this) { compact => 12, standard => 20, large => 28, expanded => 40 };

  /// Widest a reading column may get; wider screens centre it instead of stretching text lines.
  double get maxContentWidth => switch (this) { compact || standard => double.infinity, large => 640, expanded => 760 };

  bool get isTablet => this == large || this == expanded;
}

extension AdaptiveContext on BuildContext {
  ScreenClass get screenClass => ScreenClass.of(MediaQuery.sizeOf(this).width);
}

/// Centres its child in a readable column on wide screens and passes it through unchanged on phones.
class AdaptiveContent extends StatelessWidget {
  const AdaptiveContent({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final max = ScreenClass.of(c.maxWidth).maxContentWidth;
        if (max == double.infinity || c.maxWidth <= max) return child;
        return Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: BoxConstraints(maxWidth: max), child: child));
      });
}

/// Lays children in equal-width columns that wrap. [columnsFor] picks the column count from the available width;
/// rows grow with the text size, so labels are never clipped.
class AdaptiveWrapGrid extends StatelessWidget {
  const AdaptiveWrapGrid({super.key, required this.children, required this.columnsFor, this.spacing = 8, this.runSpacing = 8});
  final List<Widget> children;
  final int Function(double width) columnsFor;
  final double spacing;
  final double runSpacing;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final cols = columnsFor(c.maxWidth).clamp(1, children.isEmpty ? 1 : children.length);
        final w = (c.maxWidth - spacing * (cols - 1)) / cols;
        return Wrap(spacing: spacing, runSpacing: runSpacing, children: [for (final ch in children) SizedBox(width: w, child: ch)]);
      });
}
