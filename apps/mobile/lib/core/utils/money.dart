/// Money is integer minor units (cents) everywhere. These helpers only FORMAT for display; no arithmetic on doubles.
String formatMinor(int minor, {String currency = 'LKR', bool signed = false}) {
  final neg = minor < 0;
  final abs = minor.abs();
  final whole = (abs ~/ 100).toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  final frac = (abs % 100).toString().padLeft(2, '0');
  final sign = neg ? '-' : (signed && minor > 0 ? '+' : '');
  return '$sign$currency $whole.$frac';
}

const hiddenAmount = 'LKR ••••••';

/// Parses what a customer types ("2,500.50", "2500", "0.5") into minor units WITHOUT floating point.
/// Returns null for anything that is not a positive amount with at most 2 decimals.
int? parseMajorToMinor(String input) {
  final t = input.trim().replaceAll(',', '');
  final m = RegExp(r'^(\d{1,12})(?:\.(\d{1,2}))?$').firstMatch(t);
  if (m == null) return null;
  final minor = int.parse(m.group(1)!) * 100 + int.parse((m.group(2) ?? '').padRight(2, '0'));
  return minor > 0 ? minor : null;
}
