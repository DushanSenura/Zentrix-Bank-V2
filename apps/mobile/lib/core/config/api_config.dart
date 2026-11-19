/// API base URL, injected at build time: --dart-define=API_BASE_URL=https://...
/// Default targets the Android emulator's host loopback. There is NO mock fallback:
/// if the backend is unreachable the app says so instead of pretending.
class ApiConfig {
  static const baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000');
}
