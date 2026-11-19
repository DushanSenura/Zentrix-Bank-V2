import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/health/health_provider.dart';

const _primary = Color(0xFF155EEF);

final _router = GoRouter(routes: [
  GoRoute(path: '/', builder: (_, _) => const _ShellPage()),
]);

class ZentrixApp extends StatelessWidget {
  const ZentrixApp({super.key});

  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(
          useMaterial3: true,
          fontFamily: 'Manrope',
          colorScheme: ColorScheme.fromSeed(seedColor: _primary, brightness: b),
        );
    return MaterialApp.router(
      title: 'Zentrix Bank',
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      routerConfig: _router,
    );
  }
}

/// Phase 1 shell: proves the app reaches the real backend. Auth and banking screens start in Phase 2.
class _ShellPage extends ConsumerWidget {
  const _ShellPage();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final health = ref.watch(healthProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Image.asset('assets/brand/bank_logo.png', height: 96, semanticLabel: 'Zentrix Bank logo'),
              const SizedBox(height: 16),
              Text('Zentrix Bank', style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 24),
              health.when(
                loading: () => const CircularProgressIndicator(),
                error: (_, _) => Column(children: [
                  const Text('Cannot reach the Zentrix API.'),
                  TextButton(onPressed: () => ref.invalidate(healthProvider), child: const Text('Retry')),
                ]),
                data: (h) => Text(h.ok ? 'Backend connected' : 'Backend degraded (db: ${h.database}, redis: ${h.redis})'),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
