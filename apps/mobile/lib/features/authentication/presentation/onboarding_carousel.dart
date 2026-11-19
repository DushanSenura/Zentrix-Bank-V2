import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../settings/settings_controller.dart';

const _slides = [
  (Icons.account_balance_wallet_outlined, 'All your money, one place', 'Accounts, cards, deposits and loans together, always showing what the bank has recorded.'),
  (Icons.swap_horiz_rounded, 'Move money with confidence', 'Every payment is checked and authorised by the bank, with a receipt you can trust.'),
  (Icons.shield_outlined, 'Security that stays out of the way', 'PIN and biometric unlock, device control and instant alerts keep your account yours.'),
];

class OnboardingPage extends ConsumerStatefulWidget {
  const OnboardingPage({super.key});
  @override
  ConsumerState<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends ConsumerState<OnboardingPage> {
  final _c = PageController();
  int _i = 0;

  @override
  void dispose() { _c.dispose(); super.dispose(); }

  Future<void> _finish() async {
    final router = GoRouter.of(context);
    await ref.read(settingsProvider.notifier).markOnboarded();
    router.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final last = _i == _slides.length - 1;
    final dur = ZxMotion.scaled(context, ZxMotion.page);
    return Scaffold(
      body: ZxBackdrop(
        child: SafeArea(
          child: Column(children: [
            Align(alignment: Alignment.centerRight, child: TextButton(onPressed: _finish, child: const Text('Skip'))),
            Expanded(
              child: PageView.builder(
                controller: _c,
                itemCount: _slides.length,
                onPageChanged: (i) => setState(() => _i = i),
                itemBuilder: (_, i) {
                  final (icon, title, body) = _slides[i];
                  return Padding(
                    padding: const EdgeInsets.all(ZxSpace.lg),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      GlassCard(padding: const EdgeInsets.all(ZxSpace.xl), child: Icon(icon, size: 72, color: context.zx.primary, semanticLabel: title)),
                      const SizedBox(height: ZxSpace.xl),
                      Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                      const SizedBox(height: ZxSpace.md),
                      Text(body, textAlign: TextAlign.center),
                    ]),
                  );
                },
              ),
            ),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < _slides.length; i++)
                AnimatedContainer(
                  duration: ZxMotion.scaled(context, ZxMotion.standard),
                  margin: const EdgeInsets.all(4),
                  height: 8,
                  width: i == _i ? 24 : 8,
                  decoration: BoxDecoration(color: i == _i ? context.zx.primary : context.zx.textMuted.withValues(alpha: 0.4), borderRadius: BorderRadius.circular(4)),
                ),
            ]),
            Padding(
              padding: const EdgeInsets.all(ZxSpace.lg),
              child: ZxButton(label: last ? 'Get started' : 'Next', onPressed: last ? _finish : () => _c.nextPage(duration: dur, curve: ZxMotion.curve)),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Animated logo splash (fade + gentle scale; instant when reduce-motion is on).
class SplashPage extends StatelessWidget {
  const SplashPage({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ZxBackdrop(
        child: Center(
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: ZxMotion.scaled(context, ZxMotion.large),
            curve: ZxMotion.curve,
            builder: (_, v, child) => Opacity(opacity: v, child: Transform.scale(scale: 0.9 + 0.1 * v, child: child)),
            child: Image.asset('assets/brand/bank_logo.png', height: 120, semanticLabel: 'Zentrix Bank'),
          ),
        ),
      ),
    );
  }
}
