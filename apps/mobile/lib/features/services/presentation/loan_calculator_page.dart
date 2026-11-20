import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design_system/async_view.dart';
import '../../../core/design_system/tokens.dart';
import '../../../core/design_system/widgets.dart';
import '../../../core/utils/money.dart';
import '../data/services_repository.dart';

/// Estimate-only calculator. Every figure comes from the bank (`/loans/calculate`); nothing here is an offer or an approval.
class LoanCalculatorPage extends ConsumerStatefulWidget {
  const LoanCalculatorPage({super.key});
  @override
  ConsumerState<LoanCalculatorPage> createState() => _LoanCalculatorPageState();
}

class _LoanCalculatorPageState extends ConsumerState<LoanCalculatorPage> {
  String? _code;
  double _amount = 0;
  double _term = 0;
  final _income = TextEditingController();
  Future<LoanEstimate>? _estimate;

  @override
  void dispose() {
    _income.dispose();
    super.dispose();
  }

  void _recalc(LoanProductModel p) {
    final income = _income.text.trim().isEmpty ? null : parseMajorToMinor(_income.text);
    final future = ref.read(servicesRepositoryProvider).loanEstimate(p.code, _amount.round(), _term.round(), income);
    setState(() { _estimate = future; });
  }

  @override
  Widget build(BuildContext context) => ServicePage(
        title: 'Loan calculator',
        body: AsyncView<List<LoanProductModel>>(
          value: ref.watch(loanProductsProvider),
          onRetry: () => ref.invalidate(loanProductsProvider),
          builder: (products) {
            if (products.isEmpty) return const Center(child: Text('No loan products are available right now.'));
            final p = products.firstWhere((x) => x.code == _code, orElse: () => products.first);
            if (_code != p.code) {
              _code = p.code;
              _amount = p.minAmountMinor.toDouble();
              _term = p.minTermMonths.toDouble();
              _estimate = null;
            }
            final amountStep = ((p.maxAmountMinor - p.minAmountMinor) / 100).round().clamp(1, 100000);
            return ListView(padding: const EdgeInsets.all(ZxSpace.md), children: [
              GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                DropdownButtonFormField<String>(
                  initialValue: p.code, isExpanded: true, decoration: const InputDecoration(labelText: 'Loan type'),
                  items: [for (final x in products) DropdownMenuItem(value: x.code, child: Text('${x.name} · ${(x.rateBps / 100).toStringAsFixed(2)}% a year', overflow: TextOverflow.ellipsis))],
                  onChanged: (v) => setState(() => _code = v),
                ),
                const SizedBox(height: ZxSpace.md),
                Text('Amount: ${formatMinor(_amount.round())}', style: Theme.of(context).textTheme.titleSmall),
                Slider(value: _amount.clamp(p.minAmountMinor.toDouble(), p.maxAmountMinor.toDouble()), min: p.minAmountMinor.toDouble(), max: p.maxAmountMinor.toDouble(), divisions: amountStep < 2 ? null : amountStep.clamp(2, 200), label: formatMinor(_amount.round()), semanticFormatterCallback: (v) => formatMinor(v.round()), onChanged: (v) => setState(() { _amount = (v / 100).roundToDouble() * 100; }), onChangeEnd: (_) => _recalc(p)),
                Text('Term: ${_term.round()} months', style: Theme.of(context).textTheme.titleSmall),
                Slider(value: _term.clamp(p.minTermMonths.toDouble(), p.maxTermMonths.toDouble()), min: p.minTermMonths.toDouble(), max: p.maxTermMonths.toDouble(), divisions: (p.maxTermMonths - p.minTermMonths).clamp(1, 120), label: '${_term.round()} months', semanticFormatterCallback: (v) => '${v.round()} months', onChanged: (v) => setState(() => _term = v.roundToDouble()), onChangeEnd: (_) => _recalc(p)),
                TextField(controller: _income, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Monthly income (optional, LKR)', helperText: 'Adds a rough affordability note. It is not a credit decision.'), onSubmitted: (_) => _recalc(p)),
                const SizedBox(height: ZxSpace.md),
                ZxButton(label: 'Calculate', onPressed: () => _recalc(p)),
              ])),
              const SizedBox(height: ZxSpace.md),
              if (_estimate != null)
                FutureBuilder<LoanEstimate>(
                  future: _estimate,
                  builder: (context, s) {
                    if (s.connectionState != ConnectionState.done) return const Center(child: Padding(padding: EdgeInsets.all(ZxSpace.md), child: CircularProgressIndicator()));
                    if (s.hasError) return ZxErrorText(errorText(s.error!));
                    final e = s.data!;
                    return GlassCard(blur: false, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Estimated instalment', style: Theme.of(context).textTheme.titleSmall),
                      Text('${formatMinor(e.emiMinor)} a month', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                      const SizedBox(height: ZxSpace.xs),
                      Text('Total interest ${formatMinor(e.totalInterestMinor)} · total payable ${formatMinor(e.totalPayableMinor)}'),
                      if (e.band != null) Padding(padding: const EdgeInsets.only(top: ZxSpace.xs), child: Text('Affordability: ${e.band!.toLowerCase().replaceAll('_', ' ')}')),
                      const SizedBox(height: ZxSpace.xs),
                      Text(e.disclaimer ?? 'An estimate only, not an offer or an approval. The bank decides after reviewing an application.', style: const TextStyle(fontSize: 12)),
                    ]));
                  },
                ),
              const SizedBox(height: ZxSpace.md),
              OutlinedButton.icon(onPressed: () => context.push('/services/loans/apply'), icon: const Icon(Icons.request_quote_outlined), label: const Text('Apply for a loan')),
            ]);
          },
        ),
      );
}
