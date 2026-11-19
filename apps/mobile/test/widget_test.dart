import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zentrix_bank/app/app.dart';
import 'package:zentrix_bank/features/health/health_provider.dart';

void main() {
  testWidgets('shows backend connected when health is ok', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        healthProvider.overrideWith((ref) async => const ServiceHealth(ok: true, database: true, redis: true)),
      ],
      child: const ZentrixApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Backend connected'), findsOneWidget);
  });

  testWidgets('shows a real error state when the API is unreachable', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [healthProvider.overrideWith((ref) async => throw Exception('down'))],
      child: const ZentrixApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Cannot reach the Zentrix API.'), findsOneWidget);
  });
}
