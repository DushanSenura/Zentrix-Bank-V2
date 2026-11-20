import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/no_retry.dart';
import '../../authentication/data/auth_repository.dart';

class Account {
  const Account({required this.id, required this.maskedNumber, required this.productName, required this.kind, required this.status, required this.balanceMinor, required this.currency, this.nickname, this.interestRateBps = 0});
  final String id;
  final String maskedNumber;
  final String productName;
  final String kind; // SAVINGS | CURRENT | ...
  final String status; // ACTIVE | FROZEN | SUSPENDED | CLOSED
  final int balanceMinor;
  final String currency;
  final String? nickname;
  final int interestRateBps;

  String get title => nickname?.isNotEmpty == true ? nickname! : productName;

  factory Account.fromJson(Map<String, dynamic> j) => Account(
        id: j['id'] as String,
        maskedNumber: j['accountNumberMasked'] as String,
        productName: j['productName'] as String,
        kind: j['kind'] as String,
        status: j['status'] as String,
        balanceMinor: (j['balanceMinor'] as num).toInt(),
        currency: j['currency'] as String,
        nickname: j['nickname'] as String?,
        interestRateBps: (j['interestRateBps'] as num?)?.toInt() ?? 0,
      );
}

class AccountList {
  const AccountList(this.items, this.totalBalanceMinor);
  final List<Account> items;
  final int totalBalanceMinor;
}

class Txn {
  const Txn({required this.id, required this.reference, required this.kind, required this.amountMinor, required this.postedAt, this.description});
  final String id;
  final String reference;
  final String kind;
  final int amountMinor; // negative = money out
  final DateTime postedAt;
  final String? description;
}

class TxnPage {
  const TxnPage(this.items, this.nextCursor);
  final List<Txn> items;
  final String? nextCursor;
}

class Product {
  const Product({required this.code, required this.name, required this.kind, required this.minOpeningMinor, required this.interestRateBps});
  final String code;
  final String name;
  final String kind;
  final int minOpeningMinor;
  final int interestRateBps;
}

class ApplicationInfo {
  const ApplicationInfo({required this.id, required this.productName, required this.status, required this.createdAt, this.decisionReason});
  final String id;
  final String productName;
  final String status; // SUBMITTED | UNDER_REVIEW | APPROVED | REJECTED
  final DateTime createdAt;
  final String? decisionReason;
}

/// Read-only view of what the bank's ledger says. The app never computes or edits balances.
class MonthlySummary {
  const MonthlySummary({required this.month, required this.inMinor, required this.outMinor});
  final String month;
  final int inMinor;
  final int outMinor;
}

class AccountsRepository {
  AccountsRepository(this._api);
  final AuthRepository _api;

  Future<AccountList> accounts() async {
    final d = await _api.getJson('/api/v1/accounts');
    return AccountList([for (final a in (d['items'] as List).cast<Map<String, dynamic>>()) Account.fromJson(a)], (d['totalBalanceMinor'] as num).toInt());
  }

  Future<Account> account(String id) async => Account.fromJson(await _api.getJson('/api/v1/accounts/$id'));

  Future<TxnPage> transactions(String id, {String? cursor, int limit = 25}) async {
    final d = await _api.getJson('/api/v1/accounts/$id/transactions', query: {'limit': limit, 'cursor': ?cursor});
    return TxnPage([
      for (final t in (d['items'] as List).cast<Map<String, dynamic>>())
        Txn(id: t['id'] as String, reference: t['reference'] as String, kind: t['kind'] as String, description: t['description'] as String?, amountMinor: (t['amountMinor'] as num).toInt(), postedAt: DateTime.parse(t['postedAt'] as String)),
    ], d['nextCursor'] as String?);
  }

  Future<List<Product>> products() async {
    final d = await _api.getJson('/api/v1/account-products');
    return [for (final p in (d['items'] as List).cast<Map<String, dynamic>>()) Product(code: p['code'] as String, name: p['name'] as String, kind: p['kind'] as String, minOpeningMinor: (p['minOpeningMinor'] as num).toInt(), interestRateBps: (p['interestRateBps'] as num).toInt())];
  }

  Future<void> apply(String productCode, String? nickname, {String? fundingAccountId, int? fundingAmountMinor, String? pin}) =>
      _api.postJson('/api/v1/account-applications', {
        'productCode': productCode,
        'nickname': ?(nickname != null && nickname.isNotEmpty ? nickname : null),
        if (fundingAccountId != null) ...{'fundingAccountId': fundingAccountId, 'fundingAmountMinor': fundingAmountMinor, 'pin': pin},
      });

  Future<MonthlySummary> monthlySummary(String accountId) async {
    final j = await _api.getJson('/api/v1/accounts/$accountId/monthly-summary');
    return MonthlySummary(month: j['month'] as String, inMinor: (j['moneyInMinor'] as num).toInt(), outMinor: (j['moneyOutMinor'] as num).toInt());
  }

  Future<List<ApplicationInfo>> applications() async {
    final d = await _api.getJson('/api/v1/account-applications');
    return [
      for (final a in (d['items'] as List).cast<Map<String, dynamic>>())
        ApplicationInfo(id: a['id'] as String, productName: a['productName'] as String, status: a['status'] as String, createdAt: DateTime.parse(a['createdAt'] as String), decisionReason: a['decisionReason'] as String?),
    ];
  }
}

final accountsRepositoryProvider = Provider<AccountsRepository>((ref) => AccountsRepository(ref.watch(authRepositoryProvider)));
final accountListProvider = FutureProvider.autoDispose((ref) => ref.watch(accountsRepositoryProvider).accounts(), retry: noRetry);
final monthlySummaryProvider = FutureProvider.autoDispose.family<MonthlySummary, String>((ref, id) => ref.watch(accountsRepositoryProvider).monthlySummary(id), retry: noRetry);
final accountProvider = FutureProvider.autoDispose.family<Account, String>((ref, id) => ref.watch(accountsRepositoryProvider).account(id), retry: noRetry);
final productsProvider = FutureProvider.autoDispose((ref) => ref.watch(accountsRepositoryProvider).products(), retry: noRetry);
final applicationsProvider = FutureProvider.autoDispose((ref) => ref.watch(accountsRepositoryProvider).applications(), retry: noRetry);
