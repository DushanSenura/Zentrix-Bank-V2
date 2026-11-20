import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/authentication/data/auth_repository.dart';
import 'package:go_router/go_router.dart';

import 'bottom_nav.dart';
import 'tokens.dart';
import 'widgets.dart';

String errorText(Object e) => e is ApiFailure ? e.message : 'Something went wrong. Please try again.';

/// The short support reference for a failed request, when the bank supplied one.
String? errorReference(Object e) => e is ApiFailure && e.requestId != null ? 'Reference ${e.requestId}' : null;

/// Standard loading / error-with-retry / data states so every screen handles them the same way.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({super.key, required this.value, required this.onRetry, required this.builder});
  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) builder;

  @override
  Widget build(BuildContext context) => value.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(ZxSpace.lg), child: Column(mainAxisSize: MainAxisSize.min, children: [Text(errorText(e), textAlign: TextAlign.center), if (errorReference(e) != null) Text(errorReference(e)!, style: const TextStyle(fontSize: 12)), TextButton(onPressed: onRetry, child: const Text('Retry'))]))),
        data: builder,
      );
}

/// Backdrop + SafeArea scaffold used by list-style service screens.
class ServicePage extends StatelessWidget {
  const ServicePage({super.key, required this.title, required this.body, this.fab, this.actions, this.navIndex});
  final String title;
  final Widget body;
  final Widget? fab;
  final List<Widget>? actions;
  final int? navIndex; // set on the five tab pages to show the bottom navigation bar

  @override
  Widget build(BuildContext context) => Scaffold(
        // A back button is always present on non-tab pages: pop when there is somewhere to go back to, otherwise return home
        // (for example after the app was restored straight onto this page).
        appBar: AppBar(
          title: Text(title),
          actions: actions,
          automaticallyImplyLeading: false,
          leading: navIndex != null ? null : IconButton(tooltip: 'Back', icon: const Icon(Icons.arrow_back), onPressed: () => context.canPop() ? context.pop() : context.go('/')),
        ),
        floatingActionButton: fab,
        bottomNavigationBar: navIndex == null ? null : ZxBottomNav(index: navIndex!),
        body: ZxBackdrop(child: SafeArea(child: body)),
      );
}
