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
