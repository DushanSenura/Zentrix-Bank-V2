import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/no_retry.dart';
import '../../authentication/data/auth_repository.dart';

/// Random per-draft idempotency key (URL-safe, 32 hex chars).
String newIdempotencyKey() {
  final r = Random.secure();
  return List.generate(32, (_) => r.nextInt(16).toRadixString(16)).join();
}

class Recipient {
  const Recipient({required this.name, required this.accountMasked, required this.bank});
  final String name;
  final String accountMasked;
  final String bank;
}

/// What the BANK says about a payment. The app never invents fees, totals or statuses.
class Payment {
  const Payment({required this.id, required this.reference, required this.kind, required this.status, required this.amountMinor, required this.feeMinor, required this.totalMinor, required this.currency, required this.recipient, required this.sourceAccountId, this.note, this.scheduledFor, this.postedAt, this.failureMessage});
  final String id;
  final String reference;
  final String kind;
  final String status; // AWAITING_AUTHORIZATION | AUTHORIZED | POSTED | FAILED | CANCELLED ...
  final int amountMinor;
  final int feeMinor;
  final int totalMinor;
  final String currency;
  final Recipient recipient;
  final String sourceAccountId;
  final String? note;
  final DateTime? scheduledFor;
  final DateTime? postedAt;
  final String? failureMessage;

  factory Payment.fromJson(Map<String, dynamic> j) {
    final r = j['recipient'] as Map<String, dynamic>;
    return Payment(
      id: j['id'] as String,
      reference: j['reference'] as String,
      kind: j['kind'] as String,
      status: j['status'] as String,
      amountMinor: (j['amountMinor'] as num).toInt(),
      feeMinor: (j['feeMinor'] as num).toInt(),
      totalMinor: (j['totalMinor'] as num).toInt(),
      currency: j['currency'] as String,
      sourceAccountId: j['sourceAccountId'] as String,
      recipient: Recipient(name: r['name'] as String, accountMasked: r['accountMasked'] as String, bank: r['bank'] as String),
      note: j['note'] as String?,
      scheduledFor: j['scheduledFor'] == null ? null : DateTime.parse(j['scheduledFor'] as String),
      postedAt: j['postedAt'] == null ? null : DateTime.parse(j['postedAt'] as String),
      failureMessage: j['failureMessage'] as String?,
    );
  }
}

/// Everything needed to create a draft. The [key] is generated ONCE per draft so a resend after a dropped
/// connection reuses it and the bank returns the same draft instead of creating a second payment.
class DraftRequest {
  DraftRequest({required this.sourceAccountId, required this.destination, required this.amountMinor, this.note, this.scheduledFor, this.frequency, String? key}) : key = key ?? newIdempotencyKey();
  final String sourceAccountId;
  final Map<String, dynamic> destination;
  final int amountMinor;
  final String? note;
  final DateTime? scheduledFor; // one-time scheduled date, or the first run for a repeating payment
  final String? frequency; // WEEKLY | MONTHLY => standing instruction instead of a one-off payment
  final String key;

  Map<String, dynamic> toBody() => {
        'sourceAccountId': sourceAccountId,
        'destination': destination,
        'amountMinor': amountMinor,
        if (note != null && note!.isNotEmpty) 'note': note,
        if (scheduledFor != null && frequency == null) 'scheduledFor': scheduledFor!.toUtc().toIso8601String(),
      };
}

class Beneficiary {
  const Beneficiary({required this.id, required this.bankCode, required this.bankName, required this.accountMasked, required this.holderName, required this.favorite, this.nickname});
  final String id;
  final String bankCode;
  final String bankName;
  final String accountMasked;
  final String holderName;
  final bool favorite;
  final String? nickname;
  String get title => nickname?.isNotEmpty == true ? nickname! : holderName;

  factory Beneficiary.fromJson(Map<String, dynamic> j) => Beneficiary(
        id: j['id'] as String,
        bankCode: j['bankCode'] as String,
        bankName: j['bankName'] as String,
        accountMasked: j['accountNumberMasked'] as String,
        holderName: j['holderName'] as String,
        favorite: j['favorite'] == true,
        nickname: j['nickname'] as String?,
      );
}

class Biller {
  const Biller({required this.code, required this.name, required this.category});
  final String code;
  final String name;
  final String category;
}

class Bank {
  const Bank(this.code, this.name);
  final String code;
  final String name;
}

class Catalog {
  const Catalog(this.billers, this.banks);
  final List<Biller> billers;
  final List<Bank> banks;
}

class Recurring {
  const Recurring({required this.id, required this.recipient, required this.amountMinor, required this.frequency, required this.nextRunAt, this.lastFailure});
  final String id;
  final Recipient recipient;
  final int amountMinor;
  final String frequency;
  final DateTime nextRunAt;
  final String? lastFailure;
}

class NotificationItem {
  const NotificationItem({required this.id, required this.title, required this.body, required this.read, required this.createdAt});
  final String id;
  final String title;
  final String body;
  final bool read;
  final DateTime createdAt;
}

class NotificationFeed {
  const NotificationFeed(this.unread, this.items);
  final int unread;
  final List<NotificationItem> items;
}

Recipient _recipient(Map<String, dynamic> r) => Recipient(name: r['name'] as String, accountMasked: r['accountMasked'] as String, bank: r['bank'] as String);

class PaymentsRepository {
  PaymentsRepository(this._api);
  final AuthRepository _api;

  /// Step 1: creates a DRAFT (no money moves). Safe to resend with the same key.
  Future<Payment> createDraft(DraftRequest d) async =>
      Payment.fromJson(await _api.postJson('/api/v1/payments', d.toBody(), headers: {'Idempotency-Key': d.key}));

  /// Step 2: PIN is verified by the bank. Throws ApiFailure('invalid_pin') for a wrong PIN.
  Future<Payment> authorize(String id, String pin) async => Payment.fromJson(await _api.postJson('/api/v1/payments/$id/authorize', {'pin': pin}));
  Future<Payment> get(String id) async => Payment.fromJson(await _api.getJson('/api/v1/payments/$id'));
  Future<Payment> cancel(String id) async => Payment.fromJson(await _api.postJson('/api/v1/payments/$id/cancel', {}));

  Future<List<Payment>> scheduled() async {
    final d = await _api.getJson('/api/v1/payments', query: {'scheduled': 'true'});
    return [for (final p in (d['items'] as List).cast<Map<String, dynamic>>()) Payment.fromJson(p)];
  }

  Future<void> createRecurring(DraftRequest d, String pin) => _api.postJson('/api/v1/scheduled-payments', {
        'sourceAccountId': d.sourceAccountId,
        'destination': d.destination,
        'amountMinor': d.amountMinor,
        'frequency': d.frequency,
        'startDate': d.scheduledFor!.toUtc().toIso8601String(),
        if (d.note != null && d.note!.isNotEmpty) 'note': d.note,
        'pin': pin,
      });

  Future<List<Recurring>> recurring() async {
    final d = await _api.getJson('/api/v1/scheduled-payments');
    return [
      for (final r in (d['items'] as List).cast<Map<String, dynamic>>())
        Recurring(id: r['id'] as String, recipient: _recipient(r['recipient'] as Map<String, dynamic>), amountMinor: (r['amountMinor'] as num).toInt(), frequency: r['frequency'] as String, nextRunAt: DateTime.parse(r['nextRunAt'] as String), lastFailure: r['lastFailure'] as String?),
    ];
  }

  Future<void> cancelRecurring(String id) => _api.deleteJson('/api/v1/scheduled-payments/$id');

  Future<List<Beneficiary>> beneficiaries() async {
    final d = await _api.getJson('/api/v1/beneficiaries');
    return [for (final b in (d['items'] as List).cast<Map<String, dynamic>>()) Beneficiary.fromJson(b)];
  }

  Future<void> addBeneficiary({required String bankCode, required String accountNumber, String? holderName, String? nickname}) => _api.postJson('/api/v1/beneficiaries', {
        'bankCode': bankCode,
        'accountNumber': accountNumber,
        if (holderName != null && holderName.isNotEmpty) 'holderName': holderName,
        if (nickname != null && nickname.isNotEmpty) 'nickname': nickname,
      });
  Future<void> setFavorite(String id, bool v) => _api.putJson('/api/v1/beneficiaries/$id', {'favorite': v});
  Future<void> removeBeneficiary(String id) => _api.deleteJson('/api/v1/beneficiaries/$id');

  Future<Catalog> catalog() async {
    final d = await _api.getJson('/api/v1/billers');
    return Catalog([
      for (final b in (d['items'] as List).cast<Map<String, dynamic>>()) Biller(code: b['code'] as String, name: b['name'] as String, category: b['category'] as String),
    ], [
      for (final b in (d['banks'] as List).cast<Map<String, dynamic>>()) Bank(b['code'] as String, b['name'] as String),
    ]);
  }

  Future<String> myQrPayload(String accountId) async => (await _api.getJson('/api/v1/payments-qr/$accountId'))['payload'] as String;

  Future<NotificationFeed> notifications() async {
    final d = await _api.getJson('/api/v1/notifications');
    return NotificationFeed((d['unread'] as num).toInt(), [
      for (final n in (d['items'] as List).cast<Map<String, dynamic>>())
        NotificationItem(id: n['id'] as String, title: n['title'] as String, body: n['body'] as String, read: n['read'] == true, createdAt: DateTime.parse(n['createdAt'] as String)),
    ]);
  }

  Future<void> markAllRead() => _api.postJson('/api/v1/notifications/read-all', {});
}

final paymentsRepositoryProvider = Provider<PaymentsRepository>((ref) => PaymentsRepository(ref.watch(authRepositoryProvider)));
final beneficiariesProvider = FutureProvider.autoDispose((ref) => ref.watch(paymentsRepositoryProvider).beneficiaries(), retry: noRetry);
final catalogProvider = FutureProvider.autoDispose((ref) => ref.watch(paymentsRepositoryProvider).catalog(), retry: noRetry);
final scheduledProvider = FutureProvider.autoDispose((ref) => ref.watch(paymentsRepositoryProvider).scheduled(), retry: noRetry);
final recurringProvider = FutureProvider.autoDispose((ref) => ref.watch(paymentsRepositoryProvider).recurring(), retry: noRetry);
final notificationsProvider = FutureProvider.autoDispose((ref) => ref.watch(paymentsRepositoryProvider).notifications(), retry: noRetry);
