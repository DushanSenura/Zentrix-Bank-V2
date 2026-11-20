import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// The five main places in the app. Each tab page shows this bar; moving between tabs replaces the route (`go`), so the back button never
/// walks through tabs you already left.
class ZxBottomNav extends StatelessWidget {
  const ZxBottomNav({super.key, required this.index});
  final int index;

  static const destinations = [
    (Icons.home_outlined, Icons.home, 'Home', '/'),
    (Icons.swap_horiz_outlined, Icons.swap_horiz, 'Payments', '/payments'),
    (Icons.credit_card_outlined, Icons.credit_card, 'Cards', '/services/cards'),
    (Icons.receipt_long_outlined, Icons.receipt_long, 'History', '/history'),
    (Icons.person_outline, Icons.person, 'Profile', '/profile'),
  ];

  @override
  Widget build(BuildContext context) => NavigationBar(
        selectedIndex: index,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        onDestinationSelected: (i) { if (i != index) context.go(destinations[i].$4); },
        destinations: [for (final d in destinations) NavigationDestination(icon: Icon(d.$1), selectedIcon: Icon(d.$2), label: d.$3)],
      );
}
