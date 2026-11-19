import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/no_retry.dart';
import '../../authentication/data/auth_repository.dart';

int _i(Object? v) => (v as num).toInt();
int? _n(Object? v) => v == null ? null : (v as num).toInt();

class CategorySpend {
  const CategorySpend({required this.category, required this.spentMinor, required this.sharePercent, this.changePercent});
  final String category;
  final int spentMinor;
  final int sharePercent;
  final int? changePercent; // null when there was nothing to compare with last month
}

class MonthSummary {
  const MonthSummary({required this.month, required this.moneyInMinor, required this.spentMinor, required this.netMinor, required this.previousSpentMinor, required this.spentChangePercent, required this.categories});
  final String month;
  final int moneyInMinor;
  final int spentMinor;
  final int netMinor;
  final int previousSpentMinor;
  final int? spentChangePercent;
  final List<CategorySpend> categories;
}

class TrendPoint {
  const TrendPoint(this.month, this.spentMinor, this.moneyInMinor);
  final String month;
  final int spentMinor;
  final int moneyInMinor;
}

class Insight {
  const Insight(this.kind, this.title, this.detail);
  final String kind; // FACT | ESTIMATE
  final String title;
  final String detail;
  bool get isEstimate => kind == 'ESTIMATE';
}

class InsightsView {
  const InsightsView({required this.items, required this.narrative, required this.disclaimer});
  final List<Insight> items;
  final String? narrative; // only present when the bank's optional AI is on
  final String disclaimer;
}

class RecurringPayment {
  const RecurringPayment(this.name, this.amountMinor, this.frequency, this.monthlyEquivalentMinor);
  final String name;
  final int amountMinor;
  final String frequency;
  final int monthlyEquivalentMinor;
}

class HelpAnswer {
  const HelpAnswer({required this.answer, required this.answerIsAi, required this.sources, required this.actionNotice, required this.escalate});
  final String? answer;
  final bool answerIsAi;
  final List<({String title, String text})> sources;
  final String? actionNotice;
  final bool escalate;
}

/// Read-only: every figure on the insights screens is calculated by the bank from the customer's own payments.
class InsightsRepository {
  InsightsRepository(this._api);
  final AuthRepository _api;

  Future<MonthSummary> summary(String? month) async {
    final j = await _api.getJson('/api/v1/analytics/summary', query: {'month': ?month});
    return MonthSummary(
      month: j['month'] as String, moneyInMinor: _i(j['moneyInMinor']), spentMinor: _i(j['spentMinor']), netMinor: _i(j['netMinor']),
      previousSpentMinor: _i((j['previous'] as Map)['spentMinor']), spentChangePercent: _n(j['spentChangePercent']),
      categories: [for (final c in (j['categories'] as List).cast<Map<String, dynamic>>()) CategorySpend(category: c['category'] as String, spentMinor: _i(c['spentMinor']), sharePercent: _i(c['sharePercent']), changePercent: _n(c['changePercent']))],
    );
  }

  Future<List<TrendPoint>> trend() async => [for (final t in ((await _api.getJson('/api/v1/analytics/trend', query: {'months': 6}))['items'] as List).cast<Map<String, dynamic>>()) TrendPoint(t['month'] as String, _i(t['spentMinor']), _i(t['moneyInMinor']))];

  Future<List<RecurringPayment>> recurring() async => [for (final r in ((await _api.getJson('/api/v1/analytics/recurring'))['items'] as List).cast<Map<String, dynamic>>()) RecurringPayment(r['name'] as String, _i(r['amountMinor']), r['frequency'] as String, _i(r['monthlyEquivalentMinor']))];

  Future<InsightsView> insights() async {
    final j = await _api.getJson('/api/v1/ai/insights');
    return InsightsView(
      items: [for (final i in (j['items'] as List).cast<Map<String, dynamic>>()) Insight(i['kind'] as String, i['title'] as String, i['detail'] as String)],
      narrative: j['narrative'] as String?, disclaimer: j['disclaimer'] as String,
    );
  }

  Future<HelpAnswer> ask(String question, {required bool includeMyData}) async {
    final j = await _api.postJson('/api/v1/ai/ask', {'question': question, 'includeMyData': includeMyData});
    return HelpAnswer(
      answer: j['answer'] as String?, answerIsAi: j['answerIsAiGenerated'] == true, actionNotice: j['actionNotice'] as String?, escalate: j['escalate'] == true,
      sources: [for (final s in (j['sources'] as List).cast<Map<String, dynamic>>()) (title: s['title'] as String, text: s['text'] as String)],
    );
  }
}

final insightsRepositoryProvider = Provider<InsightsRepository>((ref) => InsightsRepository(ref.watch(authRepositoryProvider)));
final monthSummaryProvider = FutureProvider.autoDispose.family<MonthSummary, String?>((ref, m) => ref.watch(insightsRepositoryProvider).summary(m), retry: noRetry);
final trendProvider = FutureProvider.autoDispose((ref) => ref.watch(insightsRepositoryProvider).trend(), retry: noRetry);
final recurringProvider = FutureProvider.autoDispose((ref) => ref.watch(insightsRepositoryProvider).recurring(), retry: noRetry);
final insightsProvider = FutureProvider.autoDispose((ref) => ref.watch(insightsRepositoryProvider).insights(), retry: noRetry);
