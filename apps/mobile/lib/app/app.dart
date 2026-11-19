import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/design_system/app_theme.dart';
import '../features/authentication/presentation/auth_controller.dart';
import '../features/authentication/presentation/auth_pages.dart';
import '../features/authentication/presentation/lock.dart';
import '../features/authentication/presentation/onboarding_carousel.dart';
import '../features/authentication/presentation/onboarding_pages.dart';
import '../features/security_center/security_pages.dart';
import '../features/settings/settings_controller.dart';

const _publicRoutes = {'/login', '/register', '/forgot'};

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(authControllerProvider, (_, _) => refresh.value++);
  ref.listen(lockProvider, (_, _) => refresh.value++);
  ref.listen(settingsProvider.select((s) => s.onboarded), (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final loc = state.matchedLocation;
      if (auth.restoring) return loc == '/splash' ? null : '/splash';
      if (!auth.signedIn) {
        if (!ref.read(settingsProvider).onboarded) return loc == '/onboarding' ? null : '/onboarding';
        return (_publicRoutes.contains(loc)) ? null : '/login';
      }
      if (ref.read(lockProvider)) return loc == '/unlock' ? null : '/unlock';
      return (loc == '/splash' || loc == '/unlock' || loc == '/onboarding' || _publicRoutes.contains(loc)) ? '/' : null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const SplashPage()),
      GoRoute(path: '/onboarding', builder: (_, _) => const OnboardingPage()),
      GoRoute(path: '/login', builder: (_, _) => const LoginPage()),
      GoRoute(path: '/register', builder: (_, _) => const RegisterPage()),
      GoRoute(path: '/forgot', builder: (_, _) => const ForgotPasswordPage()),
      GoRoute(path: '/unlock', builder: (_, _) => const UnlockPage()),
      GoRoute(path: '/', builder: (_, _) => const HomePage()),
      GoRoute(path: '/kyc', builder: (_, _) => const KycPage()),
      GoRoute(path: '/pin', builder: (_, _) => const PinSetupPage()),
      GoRoute(path: '/security', builder: (_, _) => const SecurityCenterPage(), routes: [
        GoRoute(path: 'password', builder: (_, _) => const ChangePasswordPage()),
        GoRoute(path: 'pin', builder: (_, _) => const ChangePinPage()),
        GoRoute(path: 'sessions', builder: (_, _) => const SessionsPage()),
        GoRoute(path: 'devices', builder: (_, _) => const DevicesPage()),
        GoRoute(path: 'history', builder: (_, _) => const LoginHistoryPage()),
        GoRoute(path: 'preferences', builder: (_, _) => const PreferencesPage()),
      ]),
    ],
  );
});

class ZentrixApp extends ConsumerWidget {
  const ZentrixApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    return MaterialApp.router(
      title: 'Zentrix Bank',
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: settings.themeMode,
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) {
        // In-app reduce-motion switch ORs with the OS setting; every animation reads disableAnimations.
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(disableAnimations: mq.disableAnimations || settings.reduceMotion),
          child: AppLockGate(child: child ?? const SizedBox.shrink()),
        );
      },
    );
  }
}
