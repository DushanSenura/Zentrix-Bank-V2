import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/design_system/app_theme.dart';
import '../core/design_system/widgets.dart';
import '../features/authentication/presentation/auth_controller.dart';
import '../features/authentication/presentation/auth_pages.dart';
import '../features/authentication/presentation/onboarding_pages.dart';

const _publicRoutes = {'/login', '/register', '/forgot'};

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(authControllerProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    refreshListenable: refresh,
    redirect: (context, state) {
      final auth = ref.read(authControllerProvider);
      final loc = state.matchedLocation;
      if (auth.restoring) return loc == '/splash' ? null : '/splash';
      if (!auth.signedIn) return _publicRoutes.contains(loc) ? null : '/login';
      return (loc == '/splash' || _publicRoutes.contains(loc)) ? '/' : null;
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const _Splash()),
      GoRoute(path: '/login', builder: (_, _) => const LoginPage()),
      GoRoute(path: '/register', builder: (_, _) => const RegisterPage()),
      GoRoute(path: '/forgot', builder: (_, _) => const ForgotPasswordPage()),
      GoRoute(path: '/', builder: (_, _) => const HomePage()),
      GoRoute(path: '/kyc', builder: (_, _) => const KycPage()),
      GoRoute(path: '/pin', builder: (_, _) => const PinSetupPage()),
    ],
  );
});

class ZentrixApp extends ConsumerWidget {
  const ZentrixApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'Zentrix Bank',
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      routerConfig: ref.watch(routerProvider),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) => Scaffold(
        body: ZxBackdrop(
          child: Center(child: Image.asset('assets/brand/bank_logo.png', height: 120, semanticLabel: 'Zentrix Bank')),
        ),
      );
}
