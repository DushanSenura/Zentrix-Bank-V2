import 'dart:ui';

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Frosted surface. Use sparingly (one blur layer per screen region) - blur is costly.
class GlassCard extends StatelessWidget {
  const GlassCard({super.key, required this.child, this.padding = const EdgeInsets.all(ZxSpace.lg), this.blur = true});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool blur;

  @override
  Widget build(BuildContext context) {
    final c = context.zx;
    final surface = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: c.glass,
        borderRadius: BorderRadius.circular(ZxSpace.radius),
        border: Border.all(color: c.glassBorder),
        boxShadow: const [BoxShadow(color: Color(0x14071B45), blurRadius: 24, offset: Offset(0, 10))],
      ),
      child: child,
    );
    if (!blur) return surface;
    return ClipRRect(
      borderRadius: BorderRadius.circular(ZxSpace.radius),
      child: BackdropFilter(filter: ImageFilter.blur(sigmaX: 14, sigmaY: 14), child: surface),
    );
  }
}

/// Full-screen gradient backdrop used behind glass surfaces.
class ZxBackdrop extends StatelessWidget {
  const ZxBackdrop({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = context.zx;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [c.background, Color.alphaBlend(c.primary.withValues(alpha: 0.12), c.background)],
        ),
      ),
      child: child,
    );
  }
}

/// Primary action button: 52dp tall (>=48dp target), press-scale feedback, loading state.
class ZxButton extends StatefulWidget {
  const ZxButton({super.key, required this.label, required this.onPressed, this.loading = false});
  final String label;
  final VoidCallback? onPressed;
  final bool loading;

  @override
  State<ZxButton> createState() => _ZxButtonState();
}

class _ZxButtonState extends State<ZxButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null && !widget.loading;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      child: GestureDetector(
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        child: AnimatedScale(
          scale: _down ? 0.97 : 1,
          duration: ZxMotion.scaled(context, ZxMotion.micro),
          child: FilledButton(
            onPressed: enabled ? widget.onPressed : null,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: widget.loading
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(widget.label),
          ),
        ),
      ),
    );
  }
}

/// Inline error text with live-region semantics.
class ZxErrorText extends StatelessWidget {
  const ZxErrorText(this.message, {super.key});
  final String? message;

  @override
  Widget build(BuildContext context) {
    if (message == null) return const SizedBox.shrink();
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: ZxSpace.sm),
        child: Text(message!, style: TextStyle(color: context.zx.error)),
      ),
    );
  }
}
