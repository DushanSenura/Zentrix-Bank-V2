import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/no_retry.dart';
import '../../authentication/data/auth_repository.dart';
import '../../payments/data/payments_repository.dart';

int _i(Object? v) => (v as num).toInt();
DateTime _d(Object? v) => DateTime.parse(v as String);

// ───────────────────────── cards ─────────────────────────
class CardControlsModel {
  const CardControlsModel({required this.dailyLimitMinor, required this.maxDailyLimitMinor, required this.online, required this.international, required this.contactless});
  final int dailyLimitMinor;
  final int maxDailyLimitMinor;
  final bool online;
  final bool international;
  final bool contactless;
}

class BankCard {
  const BankCard({required this.id, required this.kind, required this.status, required this.statusText, required this.holderName, required this.network, this.maskedNumber, this.expiry, this.readyOn, this.collectionBranch, this.creditLimitMinor, this.controls, this.decisionReason});
  final String id;
  final String kind; // DEBIT | VIRTUAL | CREDIT
  final String status;
  final String statusText;
  final String holderName;
  final String network;
  final String? maskedNumber;
  final String? expiry;
  final DateTime? readyOn;
  final String? collectionBranch;
  final int? creditLimitMinor;
  final CardControlsModel? controls;
  final String? decisionReason;

  bool get usable => status == 'ACTIVE' || status == 'FROZEN';

  factory BankCard.fromJson(Map<String, dynamic> j) {
    final c = j['controls'] as Map<String, dynamic>?;
    return BankCard(
      id: j['id'] as String,
      kind: j['kind'] as String,
      status: j['status'] as String,
      statusText: j['statusText'] as String,
      holderName: j['holderName'] as String,
      network: j['network'] as String,
      maskedNumber: j['maskedNumber'] as String?,
      expiry: j['expiry'] as String?,
      readyOn: j['readyOn'] == null ? null : _d(j['readyOn']),
      collectionBranch: j['collectionBranch'] as String?,
      creditLimitMinor: j['creditLimitMinor'] == null ? null : _i(j['creditLimitMinor']),
      decisionReason: j['decisionReason'] as String?,
      controls: c == null ? null : CardControlsModel(dailyLimitMinor: _i(c['dailyLimitMinor']), maxDailyLimitMinor: _i(c['maxDailyLimitMinor'] ?? c['dailyLimitMinor']), online: c['onlineEnabled'] == true, international: c['internationalEnabled'] == true, contactless: c['contactlessEnabled'] == true),
    );
  }
}

class BranchInfo {
  const BranchInfo(this.id, this.name, this.city, this.type);
  final String id;
  final String name;
  final String city;
  final String type;
}

// ───────────────────────── fixed deposits ─────────────────────────
class FdRate {
  const FdRate(this.termMonths, this.rateBps, this.minAmountMinor);
  final int termMonths;
  final int rateBps;
  final int minAmountMinor;
}

class FdQuote {
  const FdQuote({required this.rateBps, required this.interestMinor, required this.maturityValueMinor, required this.maturityDate});
  final int rateBps;
  final int interestMinor;
  final int maturityValueMinor;
  final DateTime maturityDate;
}

class FixedDepositModel {
  const FixedDepositModel({required this.id, required this.reference, required this.status, required this.principalMinor, required this.rateBps, required this.termMonths, required this.maturityDate, required this.renewal, required this.interestAtMaturityMinor, required this.maturityValueMinor, required this.daysLeft, required this.renewalCount, required this.closureRequested});
  final String id;
  final String reference;
  final String status;
  final int principalMinor;
  final int rateBps;
  final int termMonths;
  final DateTime maturityDate;
  final String renewal;
  final int interestAtMaturityMinor;
  final int maturityValueMinor;
  final int daysLeft;
  final int renewalCount;
  final bool closureRequested;

  factory FixedDepositModel.fromJson(Map<String, dynamic> j) => FixedDepositModel(
        id: j['id'] as String, reference: j['reference'] as String, status: j['status'] as String, principalMinor: _i(j['principalMinor']), rateBps: _i(j['rateBps']), termMonths: _i(j['termMonths']),
        maturityDate: _d(j['maturityDate']), renewal: j['renewal'] as String, interestAtMaturityMinor: _i(j['interestAtMaturityMinor']), maturityValueMinor: _i(j['maturityValueMinor']), daysLeft: _i(j['daysLeft']),
        renewalCount: _i(j['renewalCount']), closureRequested: j['closureRequested'] == true,
      );
}

class FdList {
  const FdList(this.items, this.lockedMinor, this.interestToComeMinor);
  final List<FixedDepositModel> items;
  final int lockedMinor;
  final int interestToComeMinor;
}

// ───────────────────────── loans ─────────────────────────
class LoanProductModel {
  const LoanProductModel({required this.code, required this.name, required this.minAmountMinor, required this.maxAmountMinor, required this.minTermMonths, required this.maxTermMonths, required this.rateBps});
  final String code;
  final String name;
  final int minAmountMinor;
  final int maxAmountMinor;
  final int minTermMonths;
  final int maxTermMonths;
  final int rateBps;
}

class LoanEstimate {
  const LoanEstimate({required this.emiMinor, required this.totalInterestMinor, required this.totalPayableMinor, this.band, this.disclaimer});
  final int emiMinor;
  final int totalInterestMinor;
  final int totalPayableMinor;
  final String? band;
  final String? disclaimer;
}

class LoanSummary {
  const LoanSummary({required this.id, required this.reference, required this.productName, required this.outstandingMinor, required this.principalMinor, required this.status, this.nextDue, this.nextDueMinor, this.nextStatus});
  final String id;
  final String reference;
  final String productName;
  final int outstandingMinor;
  final int principalMinor;
  final String status;
  final DateTime? nextDue;
  final int? nextDueMinor;
  final String? nextStatus;
}

class ScheduleRow {
  const ScheduleRow(this.no, this.dueDate, this.principalMinor, this.interestMinor, this.paidMinor, this.status);
  final int no;
  final DateTime dueDate;
  final int principalMinor;
  final int interestMinor;
  final int paidMinor;
  final String status;
}

class LoanDetailModel {
  const LoanDetailModel({required this.summary, required this.schedule, required this.rateBps, required this.termMonths});
  final LoanSummary summary;
  final List<ScheduleRow> schedule;
  final int rateBps;
  final int termMonths;
}

class LoanApplicationModel {
  const LoanApplicationModel({required this.id, required this.productName, required this.amountMinor, required this.statusText, required this.status, required this.steps, this.decisionReason});
  final String id;
  final String productName;
  final int amountMinor;
  final String statusText;
  final String status;
  final List<(String, bool)> steps;
  final String? decisionReason;
}

// ───────────────────────── savings & budgets ─────────────────────────
class GoalModel {
  const GoalModel({required this.id, required this.name, required this.targetMinor, required this.savedMinor, required this.progressPercent, required this.status, this.targetDate, this.autoMonthlyMinor, this.autoNextRunAt, this.autoFailure});
  final int? autoMonthlyMinor;
  final DateTime? autoNextRunAt;
  final String? autoFailure;
  final String id;
  final String name;
  final int targetMinor;
  final int savedMinor;
  final int progressPercent;
  final String status;
  final DateTime? targetDate;
}

class BudgetModel {
  const BudgetModel({required this.category, required this.limitMinor, required this.spentMinor, required this.percentUsed, required this.state});
  final String category;
  final int limitMinor;
  final int spentMinor;
  final int percentUsed;
  final String state; // OK | NEAR | OVER
}

class BudgetsView {
  const BudgetsView(this.items, this.categories);
  final List<BudgetModel> items;
  final List<String> categories;
}

LoanSummary _loanSummary(Map<String, dynamic> j) {
  final n = j['next'] as Map<String, dynamic>?;
  return LoanSummary(id: j['id'] as String, reference: j['reference'] as String, productName: (j['productName'] as String?) ?? 'Loan', outstandingMinor: _i(j['outstandingPrincipalMinor']), principalMinor: _i(j['principalMinor']), status: j['status'] as String, nextDue: n == null ? null : _d(n['dueDate']), nextDueMinor: n == null ? null : _i(n['dueMinor']), nextStatus: n == null ? null : n['status'] as String);
}

GoalModel _goal(Map<String, dynamic> g) => GoalModel(id: g['id'] as String, name: g['name'] as String, targetMinor: _i(g['targetMinor']), savedMinor: _i(g['savedMinor']), progressPercent: _i(g['progressPercent']), status: g['status'] as String, targetDate: g['targetDate'] == null ? null : _d(g['targetDate']), autoMonthlyMinor: (g['autoSave'] as Map<String, dynamic>?) == null ? null : _i((g['autoSave'] as Map<String, dynamic>)['monthlyMinor']), autoNextRunAt: (g['autoSave'] as Map<String, dynamic>?)?['nextRunAt'] == null ? null : _d((g['autoSave'] as Map<String, dynamic>)['nextRunAt']), autoFailure: (g['autoSave'] as Map<String, dynamic>?)?['lastFailure'] as String?);

/// Read/command access to the bank's product services. Every figure shown in the app comes from the bank.
class ServicesRepository {
  ServicesRepository(this._api);
  final AuthRepository _api;

  // cards
  Future<List<BankCard>> cards() async => [for (final c in ((await _api.getJson('/api/v1/cards'))['items'] as List).cast<Map<String, dynamic>>()) BankCard.fromJson(c)];
  Future<BankCard> card(String id) async => BankCard.fromJson(await _api.getJson('/api/v1/cards/$id'));
  Future<List<BranchInfo>> branches() async => [for (final b in ((await _api.getJson('/api/v1/branches'))['items'] as List).cast<Map<String, dynamic>>()) BranchInfo(b['id'] as String, b['name'] as String, b['city'] as String, b['type'] as String)];
  Future<void> requestCard({required String kind, required String accountId, required String pin, String? branchId, Map<String, dynamic>? application}) => _api.postJson('/api/v1/cards', {'kind': kind, 'accountId': accountId, 'pin': pin, 'collectionBranchId': ?branchId, 'application': ?application});
  Future<void> freezeCard(String id, bool frozen) => _api.postJson('/api/v1/cards/$id/freeze', {'frozen': frozen});
  Future<void> setControls(String id, Map<String, dynamic> body) => _api.putJson('/api/v1/cards/$id/controls', body);
  Future<void> activateCard(String id, String pin, String cardPin) => _api.postJson('/api/v1/cards/$id/activate', {'pin': pin, 'cardPin': cardPin});
  Future<void> blockPermanently(String id, String pin) => _api.postJson('/api/v1/cards/$id/block', {'pin': pin});
  Future<void> reportLost(String id, String pin) => _api.postJson('/api/v1/cards/$id/report-lost', {'pin': pin});

  // fixed deposits
  Future<List<FdRate>> fdRates() async => [for (final r in ((await _api.getJson('/api/v1/fixed-deposits/rates'))['items'] as List).cast<Map<String, dynamic>>()) FdRate(_i(r['termMonths']), _i(r['rateBps']), _i(r['minAmountMinor']))];
  Future<FdQuote> fdQuote(int amountMinor, int termMonths) async {
    final j = await _api.getJson('/api/v1/fixed-deposits/calculate', query: {'amountMinor': amountMinor, 'termMonths': termMonths});
    return FdQuote(rateBps: _i(j['rateBps']), interestMinor: _i(j['interestMinor']), maturityValueMinor: _i(j['maturityValueMinor']), maturityDate: _d(j['maturityDate']));
  }

  Future<FdList> deposits() async {
    final j = await _api.getJson('/api/v1/fixed-deposits');
    return FdList([for (final d in (j['items'] as List).cast<Map<String, dynamic>>()) FixedDepositModel.fromJson(d)], _i(j['lockedMinor']), _i(j['interestToComeMinor']));
  }

  Future<FixedDepositModel> openDeposit({required String key, required String accountId, required int amountMinor, required int termMonths, required String renewal, required String pin}) async =>
      FixedDepositModel.fromJson(await _api.postJson('/api/v1/fixed-deposits', {'fundingAccountId': accountId, 'amountMinor': amountMinor, 'termMonths': termMonths, 'renewal': renewal, 'pin': pin}, headers: {'Idempotency-Key': key}));
  Future<void> requestClosure(String id, String? reason) => _api.postJson('/api/v1/fixed-deposits/$id/closure-request', {if (reason != null && reason.isNotEmpty) 'reason': reason});

  // loans
  Future<List<LoanProductModel>> loanProducts() async => [
        for (final p in ((await _api.getJson('/api/v1/loan-products'))['items'] as List).cast<Map<String, dynamic>>())
          LoanProductModel(code: p['code'] as String, name: p['name'] as String, minAmountMinor: _i(p['minAmountMinor']), maxAmountMinor: _i(p['maxAmountMinor']), minTermMonths: _i(p['minTermMonths']), maxTermMonths: _i(p['maxTermMonths']), rateBps: _i(p['rateBps'])),
      ];

  Future<LoanEstimate> loanEstimate(String code, int amountMinor, int termMonths, int? incomeMinor) async {
    final j = await _api.getJson('/api/v1/loans/calculate', query: {'productCode': code, 'amountMinor': amountMinor, 'termMonths': termMonths, 'monthlyIncomeMinor': ?incomeMinor});
    final e = j['eligibility'] as Map<String, dynamic>?;
    return LoanEstimate(emiMinor: _i(j['emiMinor']), totalInterestMinor: _i(j['totalInterestMinor']), totalPayableMinor: _i(j['totalPayableMinor']), band: e?['band'] as String?, disclaimer: e?['disclaimer'] as String?);
  }

  Future<void> applyLoan({required String code, required int amountMinor, required int termMonths, required int incomeMinor, required String employment, required String? purpose, required String accountId}) => _api.postJson('/api/v1/loan-applications', {
        'productCode': code, 'amountMinor': amountMinor, 'termMonths': termMonths, 'monthlyIncomeMinor': incomeMinor, 'employment': employment, if (purpose != null && purpose.isNotEmpty) 'purpose': purpose, 'disbursementAccountId': accountId, 'consent': true,
      });

  Future<List<LoanApplicationModel>> loanApplications() async => [
        for (final a in ((await _api.getJson('/api/v1/loan-applications'))['items'] as List).cast<Map<String, dynamic>>())
          LoanApplicationModel(id: a['id'] as String, productName: (a['productName'] as String?) ?? 'Loan', amountMinor: _i(a['amountMinor']), statusText: a['statusText'] as String, status: a['status'] as String, decisionReason: a['decisionReason'] as String?, steps: [for (final s in (a['steps'] as List).cast<Map<String, dynamic>>()) (s['label'] as String, s['done'] == true)]),
      ];

  Future<List<LoanSummary>> loans() async => [for (final l in ((await _api.getJson('/api/v1/loans'))['items'] as List).cast<Map<String, dynamic>>()) _loanSummary(l)];
  Future<LoanDetailModel> loan(String id) async {
    final j = await _api.getJson('/api/v1/loans/$id');
    return LoanDetailModel(summary: _loanSummary(j), rateBps: _i(j['rateBps']), termMonths: _i(j['termMonths']), schedule: [for (final r in (j['schedule'] as List).cast<Map<String, dynamic>>()) ScheduleRow(_i(r['no']), _d(r['dueDate']), _i(r['principalMinor']), _i(r['interestMinor']), _i(r['paidMinor']), r['status'] as String)]);
  }

  Future<int> settlementMinor(String id) async => _i((await _api.getJson('/api/v1/loans/$id/settlement'))['totalMinor']);

  // savings
  Future<List<GoalModel>> goals() async => [for (final g in ((await _api.getJson('/api/v1/savings/goals'))['items'] as List).cast<Map<String, dynamic>>()) _goal(g)];
  Future<void> createGoal(String name, int targetMinor, {DateTime? targetDate, int? monthlyMinor, String? accountId, String? pin}) => _api.postJson('/api/v1/savings/goals', {
        'name': name,
        'targetMinor': targetMinor,
        if (targetDate != null) 'targetDate': targetDate.toUtc().toIso8601String(),
        if (monthlyMinor != null) ...{'monthlyAutoMinor': monthlyMinor, 'autoAccountId': accountId, 'pin': pin},
      });
  Future<void> stopAutoSave(String goalId) => _api.putJson('/api/v1/savings/goals/$goalId/auto', {'monthlyAutoMinor': null});

  /// A starting budget per category from the last three full months (informational).
  Future<List<({String category, int suggestedMinor})>> budgetSuggestions() async {
    final j = await _api.getJson('/api/v1/analytics/budget-suggestions');
    return [for (final r in (j['items'] as List).cast<Map<String, dynamic>>()) (category: r['category'] as String, suggestedMinor: _i(r['suggestedMinor']))];
  }
  Future<void> moveGoal({required String key, required String goalId, required bool contribute, required String accountId, required int amountMinor, required String pin}) =>
      _api.postJson('/api/v1/savings/goals/$goalId/${contribute ? 'contribute' : 'withdraw'}', {'accountId': accountId, 'amountMinor': amountMinor, 'pin': pin}, headers: {'Idempotency-Key': key});

  Future<BudgetsView> budgets() async {
    final j = await _api.getJson('/api/v1/budgets');
    return BudgetsView([for (final b in (j['items'] as List).cast<Map<String, dynamic>>()) BudgetModel(category: b['category'] as String, limitMinor: _i(b['limitMinor']), spentMinor: _i(b['spentMinor']), percentUsed: _i(b['percentUsed']), state: b['state'] as String)], (j['categories'] as List).cast<String>());
  }

  Future<void> setBudget(String category, int limitMinor) => _api.putJson('/api/v1/budgets/${Uri.encodeComponent(category)}', {'limitMinor': limitMinor});
  Future<void> deleteBudget(String category) => _api.deleteJson('/api/v1/budgets/${Uri.encodeComponent(category)}');
}

final servicesRepositoryProvider = Provider<ServicesRepository>((ref) => ServicesRepository(ref.watch(authRepositoryProvider)));
final cardsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).cards(), retry: noRetry);
final branchesProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).branches(), retry: noRetry);
final fdRatesProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).fdRates(), retry: noRetry);
final depositsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).deposits(), retry: noRetry);
final loanProductsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).loanProducts(), retry: noRetry);
final loansProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).loans(), retry: noRetry);
final loanApplicationsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).loanApplications(), retry: noRetry);
final loanDetailProvider = FutureProvider.autoDispose.family<LoanDetailModel, String>((ref, id) => ref.watch(servicesRepositoryProvider).loan(id), retry: noRetry);
final goalsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).goals(), retry: noRetry);
final budgetsProvider = FutureProvider.autoDispose((ref) => ref.watch(servicesRepositoryProvider).budgets(), retry: noRetry);

/// Re-exported so feature pages can build the same draft used by the payment pipeline (loan instalments).
typedef LoanPaymentDraft = DraftRequest;
