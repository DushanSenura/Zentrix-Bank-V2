import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/design_system/app_theme.dart';
import '../features/accounts/presentation/accounts_pages.dart';
import '../features/authentication/presentation/auth_controller.dart';
import '../features/authentication/presentation/auth_pages.dart';
import '../features/authentication/presentation/lock.dart';
import '../features/authentication/presentation/onboarding_carousel.dart';
import '../features/authentication/presentation/onboarding_pages.dart';
import '../features/payments/data/payments_repository.dart';
import '../features/payments/presentation/payment_flow.dart';
import '../features/payments/presentation/payments_pages.dart';
import '../features/security_center/security_pages.dart';
import '../features/services/presentation/cards_pages.dart';
import '../features/support/presentation/support_pages.dart';
import '../features/services/presentation/deposits_loans_pages.dart';
import '../features/services/presentation/savings_pages.dart';
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
      GoRoute(path: '/services', builder: (_, _) => const ServicesHubPage(), routes: [
        GoRoute(path: 'cards', builder: (_, _) => const CardsPage(), routes: [
          GoRoute(path: 'request', builder: (_, _) => const RequestCardPage()),
          GoRoute(path: ':id', builder: (_, st) => CardDetailPage(id: st.pathParameters['id']!)),
        ]),
        GoRoute(path: 'deposits', builder: (_, _) => const DepositsPage(), routes: [GoRoute(path: 'open', builder: (_, _) => const OpenDepositPage())]),
        GoRoute(path: 'loans', builder: (_, _) => const LoansPage(), routes: [
          GoRoute(path: 'apply', builder: (_, _) => const LoanApplyPage()),
          GoRoute(path: ':id', builder: (_, st) => LoanDetailPage(id: st.pathParameters['id']!)),
        ]),
        GoRoute(path: 'savings', builder: (_, _) => const SavingsPage()),
        GoRoute(path: 'budgets', builder: (_, _) => const BudgetsPage()),
      ]),
      GoRoute(path: '/payments', builder: (_, _) => const PaymentsHubPage(), routes: [
        GoRoute(path: 'transfer', builder: (_, st) => TransferPage(args: st.extra is TransferArgs ? st.extra as TransferArgs : const TransferArgs())),
        GoRoute(path: 'bills', builder: (_, _) => const BillsPage()),
        GoRoute(path: 'review', builder: (_, st) => PaymentReviewPage(draft: st.extra as DraftRequest)),
        GoRoute(path: 'beneficiaries', builder: (_, _) => const BeneficiariesPage(), routes: [GoRoute(path: 'add', builder: (_, _) => const AddBeneficiaryPage())]),
        GoRoute(path: 'my-qr', builder: (_, _) => const MyQrPage()),
        GoRoute(path: 'scan', builder: (_, _) => const ScanPage()),
        GoRoute(path: 'scheduled', builder: (_, _) => const ScheduledPage()),
      ]),
      GoRoute(path: '/history', builder: (_, _) => const HistoryPage()),
      GoRoute(path: '/statements', builder: (_, _) => const StatementsPage()),
      GoRoute(path: '/support', builder: (_, _) => const SupportHubPage(), routes: [
        GoRoute(path: 'tickets', builder: (_, _) => const TicketsPage(), routes: [
          GoRoute(path: 'new', builder: (_, _) => const NewTicketPage()),
          GoRoute(path: ':id', builder: (_, st) => TicketDetailPage(id: st.pathParameters['id']!)),
        ]),
        GoRoute(path: 'disputes', builder: (_, _) => const DisputesPage()),
        GoRoute(path: 'report/:paymentId', builder: (_, st) => ReportProblemPage(paymentId: st.pathParameters['paymentId']!)),
        GoRoute(path: 'branches', builder: (_, _) => const BranchesPage()),
        GoRoute(path: 'appointments', builder: (_, _) => const AppointmentsPage()),
      ]),
      GoRoute(path: '/receipts/:id', builder: (_, st) => ReceiptPage(id: st.pathParameters['id']!)),
      GoRoute(path: '/notifications', builder: (_, _) => const NotificationsPage()),
      GoRoute(path: '/accounts/open', builder: (_, _) => const OpenAccountPage()),
      GoRoute(path: '/accounts/:id', builder: (_, st) => AccountDetailPage(id: st.pathParameters['id']!)),
      GoRoute(path: '/applications', builder: (_, _) => const ApplicationsPage()),
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
