import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/no_retry.dart';
import '../../authentication/data/auth_repository.dart';

int _i(Object? v) => (v as num).toInt();
DateTime _d(Object? v) => DateTime.parse(v as String);
List<Map<String, dynamic>> _list(Map<String, dynamic> j) => (j['items'] as List).cast<Map<String, dynamic>>();

class TxnItem {
  const TxnItem({required this.id, required this.reference, required this.description, required this.amountMinor, required this.postedAt, required this.accountLabel, this.paymentId});
  final String id;
  final String reference;
  final String description;
  final int amountMinor; // signed: credits positive, debits negative
  final DateTime postedAt;
  final String accountLabel;
  final String? paymentId;
}

class TxnPage {
  const TxnPage(this.items, this.nextCursor);
  final List<TxnItem> items;
  final String? nextCursor;
}

class TxnFilter {
  const TxnFilter({this.accountId, this.q = '', this.direction, this.category, this.from, this.to, this.minMinor, this.maxMinor});
  final String? accountId;
  final String q;
  final String? direction; // IN | OUT
  final String? category;
  final DateTime? from;
  final DateTime? to;
  final int? minMinor;
  final int? maxMinor;

  TxnFilter copyWith({String? accountId, bool clearAccount = false, String? q, String? direction, bool clearDirection = false, String? category, bool clearCategory = false, DateTime? from, DateTime? to, bool clearDates = false, int? minMinor, int? maxMinor, bool clearAmounts = false}) => TxnFilter(
        accountId: clearAccount ? null : (accountId ?? this.accountId), q: q ?? this.q, direction: clearDirection ? null : (direction ?? this.direction), category: clearCategory ? null : (category ?? this.category),
        from: clearDates ? null : (from ?? this.from), to: clearDates ? null : (to ?? this.to), minMinor: clearAmounts ? null : (minMinor ?? this.minMinor), maxMinor: clearAmounts ? null : (maxMinor ?? this.maxMinor),
      );

  /// How many of the advanced filters (beyond search text, account and direction) are on.
  int get advancedCount => (category != null ? 1 : 0) + (from != null || to != null ? 1 : 0) + (minMinor != null || maxMinor != null ? 1 : 0);
}

class TxnDetail {
  const TxnDetail({required this.id, required this.reference, required this.description, required this.status, required this.amountMinor, required this.postedAt, required this.accountLabel, required this.feeMinor, required this.canRepeat, required this.canReport, this.category, this.counterparty, this.note, this.paymentId});
  final String id;
  final String reference;
  final String description;
  final String status;
  final int amountMinor;
  final DateTime postedAt;
  final String accountLabel;
  final int feeMinor;
  final bool canRepeat;
  final bool canReport;
  final String? category;
  final String? counterparty;
  final String? note;
  final String? paymentId;
}

const spendingCategories = ['Transfers', 'Electricity', 'Water', 'Telephone & mobile', 'Internet', 'Television', 'Insurance', 'Education', 'Credit cards', 'Government & rates', 'Loan repayments', 'Other'];

class Dispute {
  const Dispute({required this.id, required this.reference, required this.status, required this.statusText, required this.reasonCode, required this.createdAt, this.resolution, this.paymentReference});
  final String id;
  final String reference;
  final String status;
  final String statusText;
  final String reasonCode;
  final DateTime createdAt;
  final String? resolution;
  final String? paymentReference;
}

class Ticket {
  const Ticket({required this.id, required this.reference, required this.subject, required this.category, required this.status, required this.statusText, required this.updatedAt, this.messages = const []});
  final String id;
  final String reference;
  final String subject;
  final String category;
  final String status;
  final String statusText;
  final DateTime updatedAt;
  final List<TicketMessage> messages;
}

class TicketMessage {
  const TicketMessage(this.from, this.body, this.at);
  final String from; // CUSTOMER | STAFF
  final String body;
  final DateTime at;
}

class Branch {
  const Branch({required this.id, required this.name, required this.city, required this.address, required this.type, this.phone, this.hours, this.latitude, this.longitude, this.distanceKm});
  final double? latitude;
  final double? longitude;
  final double? distanceKm; // only when the customer asked for places near them
  final String id;
  final String name;
  final String city;
  final String address;
  final String type;
  final String? phone;
  final String? hours;
}

class Appointment {
  const Appointment({required this.id, required this.branch, required this.purpose, required this.preferredAt, required this.status, this.confirmedFor});
  final String id;
  final String branch;
  final String purpose;
  final DateTime preferredAt;
  final String status;
  final DateTime? confirmedFor;
}

class Faq {
  const Faq(this.q, this.a);
  final String q;
  final String a;
}

const disputeReasons = {
  'UNAUTHORISED': 'I did not make this payment',
  'WRONG_AMOUNT': 'The amount is wrong',
  'DUPLICATE': 'I was charged twice',
  'NOT_RECEIVED': 'The recipient did not receive it',
  'OTHER': 'Something else',
};
const ticketCategories = {'GENERAL': 'General', 'ACCOUNT': 'Account', 'CARD': 'Card', 'PAYMENT': 'Payment', 'LOAN': 'Loan', 'TECHNICAL': 'App problem'};
const statementLanguages = {'en': 'English', 'si': 'සිංහල', 'ta': 'தமிழ்'};

/// Everything shown here is what the bank returned; the app never computes balances or statuses itself.
class SupportRepository {
  SupportRepository(this._api);
  final AuthRepository _api;

  Future<TxnPage> transactions(TxnFilter f, {String? cursor}) async {
    final j = await _api.getJson('/api/v1/transactions', query: {
      'limit': 25,
      'accountId': ?f.accountId,
      if (f.q.trim().length >= 2) 'q': f.q.trim(),
      'direction': ?f.direction,
      'category': ?f.category,
      if (f.from != null) 'from': _day(f.from!),
      if (f.to != null) 'to': _day(f.to!),
      'minMinor': ?f.minMinor,
      'maxMinor': ?f.maxMinor,
      'cursor': ?cursor,
    });
    return TxnPage([
      for (final t in _list(j))
        TxnItem(id: t['id'] as String, reference: t['reference'] as String, description: (t['description'] as String?) ?? (t['kind'] as String), amountMinor: _i(t['amountMinor']), postedAt: _d(t['postedAt']), accountLabel: (t['accountLabel'] as String?) ?? '', paymentId: t['paymentId'] as String?),
    ], j['nextCursor'] as String?);
  }

  static String _day(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<TxnDetail> transactionDetail(String id) async {
    final j = await _api.getJson('/api/v1/transactions/$id');
    final cp = j['counterparty'] as Map<String, dynamic>?;
    return TxnDetail(
      id: j['id'] as String, reference: j['reference'] as String, description: (j['description'] as String?) ?? (j['kind'] as String), status: j['status'] as String, amountMinor: _i(j['amountMinor']), postedAt: _d(j['postedAt']),
      accountLabel: (j['account'] as Map)['label'] as String, feeMinor: _i(j['feeMinor']), canRepeat: j['canRepeat'] == true, canReport: j['canReport'] == true, category: j['category'] as String?, note: j['note'] as String?, paymentId: j['paymentId'] as String?,
      counterparty: cp == null ? null : [cp['name'], cp['bank'], cp['accountMasked']].where((x) => x != null && '$x'.isNotEmpty).join(' · '),
    );
  }

  /// The body of a new draft copied from an earlier payment of this customer's (the recipient is never invented).
  Future<Map<String, dynamic>> repeatDraft(String paymentId) => _api.getJson('/api/v1/payments/$paymentId/repeat');

  Future<List<Dispute>> disputes() async => [
        for (final d in _list(await _api.getJson('/api/v1/disputes')))
          Dispute(id: d['id'] as String, reference: d['reference'] as String, status: d['status'] as String, statusText: d['statusText'] as String, reasonCode: d['reasonCode'] as String, createdAt: _d(d['createdAt']), resolution: d['resolution'] as String?, paymentReference: (d['payment'] as Map?)?['reference'] as String?),
      ];

  Future<void> reportProblem({required String paymentId, required String reasonCode, required String description}) => _api.postJson('/api/v1/disputes', {'paymentId': paymentId, 'reasonCode': reasonCode, 'description': description});

  Future<List<Faq>> faqs() async => [for (final f in _list(await _api.getJson('/api/v1/support/faqs'))) Faq(f['q'] as String, f['a'] as String)];

  Ticket _ticket(Map<String, dynamic> t) => Ticket(
        id: t['id'] as String, reference: t['reference'] as String, subject: t['subject'] as String, category: t['category'] as String, status: t['status'] as String, statusText: t['statusText'] as String, updatedAt: _d(t['updatedAt']),
        messages: [for (final m in ((t['messages'] as List?) ?? const []).cast<Map<String, dynamic>>()) TicketMessage(m['from'] as String, m['body'] as String, _d(m['at']))],
      );

  Future<List<Ticket>> tickets() async => [for (final t in _list(await _api.getJson('/api/v1/support/tickets'))) _ticket(t)];
  Future<Ticket> ticket(String id) async => _ticket(await _api.getJson('/api/v1/support/tickets/$id'));
  Future<void> createTicket({required String subject, required String category, required String message}) => _api.postJson('/api/v1/support/tickets', {'subject': subject, 'category': category, 'message': message});
  Future<void> replyTicket(String id, String body) => _api.postJson('/api/v1/support/tickets/$id/messages', {'body': body});
  Future<void> closeTicket(String id) => _api.postJson('/api/v1/support/tickets/$id/close', {});

  Future<List<Branch>> branches({String? city, String? type, double? lat, double? lng}) async => [
        for (final b in _list(await _api.getJson('/api/v1/branches', query: {if (city != null && city.trim().isNotEmpty) 'city': city.trim(), 'type': ?type, 'lat': ?lat, 'lng': ?lng})))
          Branch(id: b['id'] as String, name: b['name'] as String, city: b['city'] as String, address: b['address'] as String, type: b['type'] as String, phone: b['phone'] as String?, hours: b['hours'] as String?, latitude: (b['latitude'] as num?)?.toDouble(), longitude: (b['longitude'] as num?)?.toDouble(), distanceKm: (b['distanceKm'] as num?)?.toDouble()),
      ];

  Future<List<Appointment>> appointments() async => [
        for (final a in _list(await _api.getJson('/api/v1/appointments')))
          Appointment(id: a['id'] as String, branch: (a['branch'] as String?) ?? 'Branch', purpose: a['purpose'] as String, preferredAt: _d(a['preferredAt']), status: a['status'] as String, confirmedFor: a['confirmedFor'] == null ? null : _d(a['confirmedFor'])),
      ];
  Future<void> bookAppointment({required String branchId, required String purpose, required DateTime preferredAt}) => _api.postJson('/api/v1/appointments', {'branchId': branchId, 'purpose': purpose, 'preferredAt': preferredAt.toUtc().toIso8601String()});
  Future<void> cancelAppointment(String id) => _api.postJson('/api/v1/appointments/$id/cancel', {});

  /// Statement / receipt as raw file bytes straight from the bank.
  Future<DownloadedFile> statement({required String accountId, required String from, required String to, required String format, required String lang}) =>
      _api.getFile('/api/v1/accounts/$accountId/statement', query: {'from': from, 'to': to, 'format': format, 'lang': lang});
  Future<DownloadedFile> receipt(String paymentId, String lang) => _api.getFile('/api/v1/payments/$paymentId/receipt', query: {'lang': lang});
}

class DownloadedFile {
  const DownloadedFile(this.bytes, this.fileName, this.mimeType);
  final Uint8List bytes;
  final String fileName;
  final String mimeType;
}

final supportRepositoryProvider = Provider<SupportRepository>((ref) => SupportRepository(ref.watch(authRepositoryProvider)));
final disputesProvider = FutureProvider.autoDispose((ref) => ref.watch(supportRepositoryProvider).disputes(), retry: noRetry);
final faqsProvider = FutureProvider.autoDispose((ref) => ref.watch(supportRepositoryProvider).faqs(), retry: noRetry);
final ticketsProvider = FutureProvider.autoDispose((ref) => ref.watch(supportRepositoryProvider).tickets(), retry: noRetry);
final ticketProvider = FutureProvider.autoDispose.family<Ticket, String>((ref, id) => ref.watch(supportRepositoryProvider).ticket(id), retry: noRetry);
final appointmentsProvider = FutureProvider.autoDispose((ref) => ref.watch(supportRepositoryProvider).appointments(), retry: noRetry);
final branchFinderProvider = FutureProvider.autoDispose.family<List<Branch>, ({String city, String? type, double? lat, double? lng})>((ref, f) => ref.watch(supportRepositoryProvider).branches(city: f.city, type: f.type, lat: f.lat, lng: f.lng), retry: noRetry);

/// Hands a downloaded file to the OS share sheet. Overridden in tests so no platform plugin is touched.
abstract class FileSharer {
  Future<void> share(DownloadedFile f);
}
