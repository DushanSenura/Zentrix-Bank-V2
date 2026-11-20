import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

/// Opens phone, email and map links through the phone's own apps. Replaced in tests so nothing is launched.
abstract class LinkLauncher {
  Future<bool> open(Uri uri);
}

class PlatformLinkLauncher implements LinkLauncher {
  @override
  Future<bool> open(Uri uri) async => await canLaunchUrl(uri) && await launchUrl(uri, mode: LaunchMode.externalApplication);
}

final linkLauncherProvider = Provider<LinkLauncher>((ref) => PlatformLinkLauncher());

Uri phoneUri(String number) => Uri(scheme: 'tel', path: number.replaceAll(RegExp(r'[^0-9+]'), ''));
// Built by hand: Uri.queryParameters writes spaces as '+', which mail apps show literally.
Uri emailUri(String address, {String? subject}) => Uri.parse('mailto:$address${subject == null ? '' : '?subject=${Uri.encodeComponent(subject)}'}');
Uri mapsUri(double lat, double lng, {String? label}) => Uri.https('www.google.com', '/maps/search/', {'api': '1', 'query': '$lat,$lng${label != null ? ' ($label)' : ''}'});

class Coordinates {
  const Coordinates(this.lat, this.lng);
  final double lat;
  final double lng;
}

class LocationDenied implements Exception {
  LocationDenied(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One-off, coarse location, only when the customer asks to see what is near them. Never stored or sent anywhere except as a sort
/// order request to the bank's branch list.
abstract class LocationService {
  Future<Coordinates> current();
}

class PlatformLocationService implements LocationService {
  @override
  Future<Coordinates> current() async {
    if (!await Geolocator.isLocationServiceEnabled()) throw LocationDenied('Location is turned off on this phone.');
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    if (p == LocationPermission.denied || p == LocationPermission.deniedForever) throw LocationDenied('Location permission was not given. You can still search by city.');
    final pos = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 10)));
    return Coordinates(pos.latitude, pos.longitude);
  }
}

final locationServiceProvider = Provider<LocationService>((ref) => PlatformLocationService());
