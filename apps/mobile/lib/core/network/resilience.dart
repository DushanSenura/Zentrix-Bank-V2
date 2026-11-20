import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Set by the API client when the bank answers 503 "maintenance"; cleared when any call succeeds or the customer retries successfully.
final ValueNotifier<String?> maintenanceNotifier = ValueNotifier<String?>(null);

/// Set by the API client when the session can no longer be refreshed. The auth controller reacts by signing the customer out.
final ValueNotifier<bool> sessionExpiredNotifier = ValueNotifier<bool>(false);

/// Whether the phone has a network interface up. Interface-up is NOT proof the bank is reachable: real failures still arrive as network errors.
abstract class OnlineService {
  Stream<bool> changes();
  Future<bool> current();
}

class ConnectivityOnlineService implements OnlineService {
  static bool _up(List<ConnectivityResult> r) => r.any((x) => x != ConnectivityResult.none);
  @override
  Future<bool> current() async => _up(await Connectivity().checkConnectivity());
  @override
  Stream<bool> changes() => Connectivity().onConnectivityChanged.map(_up);
}

final onlineServiceProvider = Provider<OnlineService>((ref) => ConnectivityOnlineService());

/// true while online. Starts optimistic so the banner never flashes at launch.
final onlineProvider = StreamProvider<bool>((ref) async* {
  final svc = ref.watch(onlineServiceProvider);
  yield await svc.current().catchError((_) => true);
  yield* svc.changes();
});

/// A thin banner shown above the app while the phone is offline.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key, required this.child, this.onReconnect});
  final Widget child;
  /// Called once each time the phone comes back online, so screens can refresh what they showed before the drop.
  final void Function()? onReconnect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen<AsyncValue<bool>>(onlineProvider, (prev, next) {
      if (prev?.asData?.value == false && next.asData?.value == true) onReconnect?.call();
    });
    final online = ref.watch(onlineProvider).asData?.value ?? true;
    return Column(children: [
      if (!online)
        Semantics(
          liveRegion: true,
          container: true,
          child: Material(
            color: Theme.of(context).colorScheme.errorContainer,
            child: SafeArea(bottom: false, child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(children: [
                Icon(Icons.wifi_off, size: 18, color: Theme.of(context).colorScheme.onErrorContainer),
                const SizedBox(width: 8),
                Expanded(child: Text('You are offline. Payments are paused until you reconnect.', style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onErrorContainer))),
              ]),
            )),
          ),
        ),
      Expanded(child: child),
    ]);
  }
}

/// Full-screen notice over the app while the bank is in maintenance. Navigation underneath is preserved.
class MaintenanceGate extends StatelessWidget {
  const MaintenanceGate({super.key, required this.child, required this.recheck});
  final Widget child;

  /// Asks the bank whether maintenance is over; returns the message while it is still on, or null when it has ended.
  final Future<String?> Function() recheck;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String?>(
        valueListenable: maintenanceNotifier,
        builder: (context, message, _) => Stack(children: [
          child,
          if (message != null) Positioned.fill(child: _MaintenanceScreen(message: message, recheck: recheck)),
        ]),
      );
}

class _MaintenanceScreen extends StatefulWidget {
  const _MaintenanceScreen({required this.message, required this.recheck});
  final String message;
  final Future<String?> Function() recheck;
  @override
  State<_MaintenanceScreen> createState() => _MaintenanceScreenState();
}

class _MaintenanceScreenState extends State<_MaintenanceScreen> {
  bool _busy = false;

  Future<void> _retry() async {
    setState(() => _busy = true);
    try {
      maintenanceNotifier.value = await widget.recheck();
    } catch (_) {
      // Still unreachable: keep the notice up.
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Material(
        color: Theme.of(context).colorScheme.surface,
        child: SafeArea(child: Center(child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.build_circle_outlined, size: 64, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 16),
            Semantics(header: true, child: Text('Back soon', style: Theme.of(context).textTheme.headlineSmall)),
            const SizedBox(height: 8),
            Text(widget.message, textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton(onPressed: _busy ? null : _retry, child: Text(_busy ? 'Checking…' : 'Try again')),
          ]),
        ))),
      );
}

/// Receives errors that escape the app. Debug builds print; plug a real service in here. Customer data must never be sent from here.
abstract class CrashReporter {
  void report(Object error, StackTrace? stack, {String? where});
}

class DebugCrashReporter implements CrashReporter {
  @override
  void report(Object error, StackTrace? stack, {String? where}) => debugPrint('[crash${where != null ? ' in $where' : ''}] ${error.runtimeType}');
}

/// Routes framework and async errors to [reporter], and in release builds replaces Flutter's red error screen with a calm message
/// (the exception text is never shown to the customer).
void installErrorHandling(CrashReporter reporter) {
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    reporter.report(details.exception, details.stack, where: details.library);
    if (kDebugMode) previous?.call(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    reporter.report(error, stack, where: 'async');
    return true;
  };
  if (kReleaseMode) {
    ErrorWidget.builder = (details) => const Material(
          child: Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Something went wrong on this screen. Go back and try again.', textAlign: TextAlign.center))),
        );
  }
}
