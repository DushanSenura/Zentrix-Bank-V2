# Authentication, sessions and RBAC (Phase 2)

* **Passwords/PINs:** Argon2id (m=19 MiB, t=2, p=1). Password policy: 10-128 chars, upper+lower+digit, must not contain username/name. App PIN: 4 or 6 digits, no repeats/straight runs, stored as an Argon2id hash.
* **Login:** username/email/customer ID. Unknown user and wrong password return the identical 401 and run one Argon2 verify (timing equalised). 5 failures lock the account for 15 min (locked accounts get the same generic 401). Failures and lockouts are recorded as security events.
* **Staff:** mandatory TOTP MFA; a staff account without enrolled MFA cannot sign in. TOTP secrets are AES-256-GCM encrypted at rest.
* **Tokens:** access JWT (HS256, 10 min, iss/aud checked) + opaque rotating refresh token (`<sessionId>.<secret>`, only a SHA-256 hash stored). Reusing a rotated refresh token revokes the session. Every request re-checks the session row, so logout/revocation is immediate.
* **Authorization:** deny-by-default global guard. Routes are authenticated unless `@Public()`; `@CustomerOnly()` / `@StaffWith(...permissions)` add type/permission checks. Denials write a `FORBIDDEN_ENDPOINT_ACCESS` security event. Public registration can only create CUSTOMER users.
* **KYC:** national ID encrypted at rest and only ever returned masked; decisions are conditional updates (no double decision), audited, and emit an outbox event. Approval activates the user.
* **Password reset:** single-use, 30-minute, hashed tokens; the request always returns 202; success revokes all sessions. Email/SMS delivery is not implemented (Phase 8) - in development the raw token is placed in the outbox payload for local testing only; it is never logged.
* **Admin web:** tokens are held in memory only (re-login after reload). Cookie/CSRF-based sessions are planned for deployment hardening.

## Known limitations
No biometric/app-lock or device trust yet; TOTP replay within a 30 s window is not blocked; no document image upload (object storage later); no staff provisioning/role-edit endpoints yet (Phase 6), so there is no self-escalation path; rate limiting is in-memory per process (move to Redis before scaling out); the mobile PIN is only stored server-side so far - server-verified step-up for payments is Phase 4.
