import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/no_retry.dart';
import '../authentication/data/auth_repository.dart';

int _i(Object? v) => (v as num).toInt();

class ProfileView {
  const ProfileView({required this.fullName, required this.customerNumber, required this.username, required this.email, required this.phone, required this.kycStatus, required this.dateOfBirth, required this.addressLine, required this.hasNationalId});
  final String fullName;
  final String customerNumber;
  final String username;
  final String email;
  final String? phone;
  final String kycStatus;
  final String? dateOfBirth;
  final String? addressLine;
  final bool hasNationalId;
}

class Prefs {
  const Prefs({required this.defaultAccountId, required this.notifications});
  final String? defaultAccountId;
  final Map<String, bool> notifications; // category -> delivered. SECURITY is always delivered and is not listed.
}

class TwoFactorStatus {
  const TwoFactorStatus({required this.enabled, required this.recoveryCodesLeft});
  final bool enabled;
  final int recoveryCodesLeft;
}

class LimitsView {
  const LimitsView({required this.dailyMinor, required this.bankMaximumMinor, required this.perTransferMinor, required this.usedTodayMinor, required this.customised});
  final int dailyMinor;
  final int bankMaximumMinor;
  final int perTransferMinor;
  final int usedTodayMinor;
  final bool customised;
}

const notificationCategoryLabels = {
  'TRANSACTION': 'Payments and transfers',
  'ACCOUNT': 'Accounts and requests',
  'CARD': 'Cards',
  'LOAN': 'Loans',
  'DEPOSIT': 'Fixed deposits',
  'BUDGET': 'Budgets',
  'OFFER': 'Offers and promotions',
  'NOTICE': 'Bank notices',
};

class ProfileRepository {
  ProfileRepository(this._api);
  final AuthRepository _api;

  Future<ProfileView> profile() async {
    final j = await _api.getJson('/api/v1/me/profile');
    final a = j['address'] as Map<String, dynamic>?;
    return ProfileView(
      fullName: j['fullName'] as String, customerNumber: j['customerNumber'] as String, username: j['username'] as String, email: j['email'] as String, phone: j['phone'] as String?,
      kycStatus: j['kycStatus'] as String, dateOfBirth: j['dateOfBirth'] as String?, hasNationalId: j['nationalIdMasked'] != null,
      addressLine: a == null ? null : [a['line1'], a['city'], a['postalCode']].where((x) => (x as String?)?.isNotEmpty ?? false).join(', '),
    );
  }

  /// Contact details only; the server verifies the app PIN.
  Future<void> updateContact({String? email, String? phone, required String pin}) =>
      _api.patchJson('/api/v1/me/profile', {'email': ?email, 'phone': ?phone, 'pin': pin});

  Future<Prefs> prefs() async {
    final j = await _api.getJson('/api/v1/me/preferences');
    return Prefs(defaultAccountId: j['defaultAccountId'] as String?, notifications: (j['notifications'] as Map).map((k, v) => MapEntry('$k', v == true)));
  }

  Future<void> setPrefs({String? defaultAccountId, bool clearDefault = false, Map<String, bool>? notifications}) =>
      _api.putJson('/api/v1/me/preferences', {if (clearDefault) 'defaultAccountId': null else 'defaultAccountId': ?defaultAccountId, 'notifications': ?notifications});

  Future<LimitsView> limits() async {
    final j = await _api.getJson('/api/v1/security/limits');
    return LimitsView(dailyMinor: _i(j['dailyMinor']), bankMaximumMinor: _i(j['bankMaximumMinor']), perTransferMinor: _i(j['perTransferMinor']), usedTodayMinor: _i(j['usedTodayMinor']), customised: j['customised'] == true);
  }

  Future<TwoFactorStatus> twoFactorStatus() async {
    final j = await _api.getJson('/api/v1/security/2fa');
    return TwoFactorStatus(enabled: j['enabled'] == true, recoveryCodesLeft: _i(j['recoveryCodesLeft']));
  }

  Future<({String secret, String uri})> twoFactorSetup(String pin) async {
    final j = await _api.postJson('/api/v1/security/2fa/setup', {'pin': pin});
    return (secret: j['secret'] as String, uri: j['otpauthUri'] as String);
  }

  Future<List<String>> twoFactorEnable(String code) async => ((await _api.postJson('/api/v1/security/2fa/enable', {'code': code}))['recoveryCodes'] as List).cast<String>();
  Future<void> twoFactorDisable(String pin, String code) => _api.postJson('/api/v1/security/2fa/disable', {'pin': pin, 'code': code});
  Future<List<String>> twoFactorNewRecoveryCodes(String pin, String code) async => ((await _api.postJson('/api/v1/security/2fa/recovery-codes', {'pin': pin, 'code': code}))['recoveryCodes'] as List).cast<String>();

  Future<void> setDailyLimit(int minor, {String? pin}) => _api.putJson('/api/v1/security/limits', {'dailyMinor': minor, 'pin': ?pin});
}

final profileRepositoryProvider = Provider<ProfileRepository>((ref) => ProfileRepository(ref.watch(authRepositoryProvider)));
final profileProvider = FutureProvider.autoDispose((ref) => ref.watch(profileRepositoryProvider).profile(), retry: noRetry);
final prefsProvider = FutureProvider.autoDispose((ref) => ref.watch(profileRepositoryProvider).prefs(), retry: noRetry);
final twoFactorProvider = FutureProvider.autoDispose((ref) => ref.watch(profileRepositoryProvider).twoFactorStatus(), retry: noRetry);
final limitsProvider = FutureProvider.autoDispose((ref) => ref.watch(profileRepositoryProvider).limits(), retry: noRetry);
