import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/no_retry.dart';
import '../authentication/data/auth_repository.dart';

int _i(Object? v) => (v as num).toInt();

class FxRateView {
  const FxRateView({required this.currency, required this.mid, required this.youPay, required this.youGet});
  final String currency;
  final double mid;
  final double youPay; // LKR per 1 unit when you BUY the currency
  final double youGet; // LKR per 1 unit when you SELL the currency
}

class FxRates {
  const FxRates(this.items, this.note);
  final List<FxRateView> items;
  final String note;
}

class FxQuote {
  const FxQuote({required this.fromAccountId, required this.toAccountId, required this.fromCurrency, required this.toCurrency, required this.fromMinor, required this.toMinor, required this.rateText, required this.token, required this.expiresAt});
  final String fromAccountId;
  final String toAccountId;
  final String fromCurrency;
  final String toCurrency;
  final int fromMinor;
  final int toMinor;
  final String rateText;
  final String token;
  final DateTime expiresAt;
}

class FxResult {
  const FxResult({required this.fromMinor, required this.toMinor, required this.fromCurrency, required this.toCurrency, required this.replayed});
  final int fromMinor;
  final int toMinor;
  final String fromCurrency;
  final String toCurrency;
  final bool replayed;
}

/// Every figure comes from the bank: the rate, the amount you get, and the quote token the bank will honour for one minute.
class FxRepository {
  FxRepository(this._api);
  final AuthRepository _api;

  Future<FxRates> rates() async {
    final j = await _api.getJson('/api/v1/fx/rates');
    return FxRates([for (final r in (j['items'] as List).cast<Map<String, dynamic>>()) FxRateView(currency: r['currency'] as String, mid: (r['midRate'] as num).toDouble(), youPay: (r['youPayPerUnit'] as num).toDouble(), youGet: (r['youGetPerUnit'] as num).toDouble())], j['note'] as String);
  }

  Future<FxQuote> quote({required String fromAccountId, required String toAccountId, required int amountMinor}) async {
    final j = await _api.getJson('/api/v1/fx/quote', query: {'fromAccountId': fromAccountId, 'toAccountId': toAccountId, 'amountMinor': amountMinor});
    return FxQuote(
      fromAccountId: j['fromAccountId'] as String, toAccountId: j['toAccountId'] as String, fromCurrency: j['fromCurrency'] as String, toCurrency: j['toCurrency'] as String,
      fromMinor: _i(j['fromAmountMinor']), toMinor: _i(j['toAmountMinor']), rateText: j['rateText'] as String, token: j['token'] as String, expiresAt: DateTime.parse(j['expiresAt'] as String),
    );
  }

  Future<FxResult> exchange(String token, String pin) async {
    final j = await _api.postJson('/api/v1/fx/exchange', {'token': token, 'pin': pin});
    return FxResult(fromMinor: _i(j['fromAmountMinor']), toMinor: _i(j['toAmountMinor']), fromCurrency: j['fromCurrency'] as String, toCurrency: j['toCurrency'] as String, replayed: j['replayed'] == true);
  }
}

final fxRepositoryProvider = Provider<FxRepository>((ref) => FxRepository(ref.watch(authRepositoryProvider)));
final fxRatesProvider = FutureProvider.autoDispose((ref) => ref.watch(fxRepositoryProvider).rates(), retry: noRetry);
