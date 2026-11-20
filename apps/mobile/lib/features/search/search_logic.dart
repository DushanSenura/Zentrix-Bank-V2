/// Pure matcher for the in-app search. Features and settings live on the device; saved recipients and transactions come from the bank.
class SearchEntry {
  const SearchEntry(this.title, this.subtitle, this.route, this.keywords, {this.isSetting = false});
  final String title;
  final String subtitle;
  final String route;
  final List<String> keywords;
  final bool isSetting;
}

const searchEntries = <SearchEntry>[
  SearchEntry('Transfer money', 'Own accounts, saved recipients, other banks', '/payments/transfer', ['send', 'pay', 'transfer', 'move money', 'beneficiary']),
  SearchEntry('Pay bills', 'Electricity, water, phone and more', '/payments/bills', ['bill', 'electricity', 'water', 'telephone', 'internet', 'insurance']),
  SearchEntry('Scan a QR code', 'Pay another Zentrix customer', '/payments/scan', ['qr', 'scan', 'camera']),
  SearchEntry('My QR code', 'Let someone pay you', '/payments/my-qr', ['qr', 'receive', 'my code']),
  SearchEntry('Saved recipients', 'Beneficiaries and favourites', '/payments/beneficiaries', ['beneficiary', 'beneficiaries', 'recipient', 'payee', 'favourite']),
  SearchEntry('Scheduled payments', 'Upcoming and repeating payments', '/payments/scheduled', ['scheduled', 'recurring', 'repeat', 'standing order']),
  SearchEntry('Cards', 'Debit, virtual and credit cards', '/services/cards', ['card', 'debit', 'virtual', 'credit', 'freeze', 'lost']),
  SearchEntry('Fixed deposits', 'Lock money away and earn interest', '/services/deposits', ['fixed deposit', 'fd', 'interest', 'savings']),
  SearchEntry('Loans', 'Apply, track and repay', '/services/loans', ['loan', 'borrow', 'instalment', 'repay']),
  SearchEntry('Loan calculator', 'Estimate a monthly instalment', '/services/loans/calculator', ['loan', 'calculator', 'emi', 'estimate']),
  SearchEntry('Savings goals', 'Save towards what matters', '/services/savings', ['goal', 'savings', 'save']),
  SearchEntry('Budgets', 'Monthly spending targets', '/services/budgets', ['budget', 'spending limit']),
  SearchEntry('Spending insights', 'Where your money goes', '/insights', ['analytics', 'insights', 'spending', 'income', 'cash flow', 'charts']),
  SearchEntry('Transaction history', 'Search and filter', '/history', ['transactions', 'history', 'activity']),
  SearchEntry('Statements', 'PDF or spreadsheet', '/statements', ['statement', 'pdf', 'csv', 'download']),
  SearchEntry('Currency exchange', 'Move money between your currencies', '/services/exchange', ['exchange', 'currency', 'foreign', 'fx', 'usd', 'dollar']),
  SearchEntry('Notifications', 'Alerts and updates', '/notifications', ['notification', 'alert', 'bell']),
  SearchEntry('Help and support', 'Messages, problem reports, branches', '/support', ['help', 'support', 'faq', 'contact', 'branch', 'atm', 'dispute']),
  SearchEntry('Branches and ATMs', 'Find us and book a visit', '/support/branches', ['branch', 'atm', 'location', 'appointment', 'near me']),
  SearchEntry('Profile', 'Your details', '/profile', ['profile', 'account details', 'email', 'phone', 'address']),
  SearchEntry('Settings', 'Theme, notifications, default account', '/settings', ['settings', 'theme', 'dark', 'language', 'notification settings', 'default account', 'show balances'], isSetting: true),
  SearchEntry('Security centre', 'Password, PIN, devices', '/security', ['security', 'password', 'pin', 'biometric', 'two-factor', '2fa'], isSetting: true),
  SearchEntry('Change password', 'Use a new password', '/security/password', ['password', 'change password'], isSetting: true),
  SearchEntry('Change app PIN', 'Use a new PIN', '/security/pin', ['pin', 'change pin'], isSetting: true),
  SearchEntry('Active sessions', 'Where you are signed in', '/security/sessions', ['sessions', 'sign out', 'devices'], isSetting: true),
  SearchEntry('Trusted devices', 'Devices you trust', '/security/devices', ['device', 'trusted'], isSetting: true),
  SearchEntry('Login history', 'Recent sign-ins', '/security/history', ['login', 'sign in', 'history'], isSetting: true),
  SearchEntry('Transfer limits', 'Your daily limit', '/security/limits', ['limit', 'daily limit', 'transfer limit'], isSetting: true),
  SearchEntry('App lock and appearance', 'Biometrics, auto-lock, theme', '/security/preferences', ['lock', 'biometric', 'fingerprint', 'face', 'theme', 'reduce motion'], isSetting: true),
];

/// Entries whose title, subtitle or keywords contain every word typed, best matches first.
List<SearchEntry> matchEntries(String query, {List<SearchEntry> entries = searchEntries}) {
  final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty || query.trim().length < 2) return const [];
  final scored = <(SearchEntry, int)>[];
  for (final e in entries) {
    final title = e.title.toLowerCase();
    final hay = '$title ${e.subtitle.toLowerCase()} ${e.keywords.join(' ').toLowerCase()}';
    if (!words.every(hay.contains)) continue;
    var score = 0;
    for (final w in words) {
      if (title.startsWith(w)) { score += 3; } else if (title.contains(w)) { score += 2; } else { score += 1; }
    }
    scored.add((e, score));
  }
  scored.sort((a, b) => b.$2.compareTo(a.$2));
  return [for (final s in scored) s.$1];
}
