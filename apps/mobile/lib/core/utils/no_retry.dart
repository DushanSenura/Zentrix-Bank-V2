/// Riverpod 3 silently retries failed providers with backoff. For banking screens we want the failure shown
/// immediately with an explicit Retry button, so automatic retry is switched off.
Duration? noRetry(int retryCount, Object error) => null;
