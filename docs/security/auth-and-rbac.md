# Authentication, sessions and RBAC (Phase 2)

* **Passwords/PINs:** Argon2id (m=19 MiB, t=2, p=1). Password policy: 10-128 chars, upper+lower+digit, must not contain username/name. App PIN: 4 or 6 digits, no repeats/straight runs, stored as an Argon2id hash.
* **Login:** username/email/customer ID. Unknown user and wrong password return the identical 401 and run one Argon2 verify (timing equalised). 5 failures lock the account for 15 min (locked accounts get the same generic 401). Failures and lockouts are recorded as security events.
* **Staff:** mandatory TOTP MFA; a staff account without enrolled MFA cannot sign in. TOTP secrets are AES-256-GCM encrypted at rest.
* **Tokens:** access JWT (HS256, 10 min, iss/aud checked) + opaque rotating refresh token (`<sessionId>.<secret>`, only a SHA-256 hash stored). Reusing a rotated refresh token revokes the session. Every request re-checks the session row, so logout/revocation is immediate.
* **Authorization:** deny-by-default global guard. Routes are authenticated unless `@Public()`; `@CustomerOnly()` / `@StaffWith(...permissions)` add type/permission checks. Denials write a `FORBIDDEN_ENDPOINT_ACCESS` security event. Public registration can only create CUSTOMER users.
* **KYC:** national ID encrypted at rest and only ever returned masked; decisions are conditional updates (no double decision), audited, and emit an outbox event. Approval activates the user.
* **Password reset:** single-use, 30-minute, hashed tokens; the request always returns 202; success revokes all sessions. Email/SMS delivery is not implemented (Phase 8) - in development the raw token is placed in the outbox payload for local testing only; it is never logged.
* **Admin web:** tokens are held in memory only (re-login after reload). Cookie/CSRF-based sessions are planned for deployment hardening.

* **Security centre (customer):** sessions, trusted devices and login history are strictly scoped to the caller (another customer's id returns 404). Password change needs the current password and signs out all other sessions; PIN change needs the current PIN; `PUT /me/pin` is first-time only. Five consecutive wrong PINs revoke every session and record a HIGH security event.
* **Mobile:** only the refresh token is persisted (Keystore/Keychain); the app PIN is verified by the server; biometrics only lift the local lock (the OS returns yes/no). The app locks on cold start with a remembered session and after the configured background timeout; content is covered in the app switcher; Android release builds set FLAG_SECURE, `allowBackup=false`, no cleartext (debug only).

## Known limitations
TOTP replay within a 30 s window is not blocked; no document image upload (object storage later); no staff provisioning/role-edit endpoints yet (Phase 6), so there is no self-escalation path; rate limiting is in-memory per process (move to Redis before scaling out); the mobile PIN is only stored server-side so far - server-verified step-up for payments is Phase 4.

## Administration controls (Phase 6)
* **Escalation guards (server-side):** a staff member can grant only roles/permissions they hold; cannot change their own access; cannot manage anyone whose permissions exceed their own; the Super Administrator role is immutable and the last active Super Administrator cannot be demoted or deactivated.
* **Two-person rules:** loan disbursement, payment reversals and ledger adjustments need a different staff member to approve (code check + database CHECK). Violations are recorded as HIGH security events.
* **Invitations:** staff accounts start with an unusable random password; a single-use 72 h token lets the invitee set a password and receive their TOTP secret once. The token is only echoed in development.
* **Exports:** CSV is capped (5,000 rows), permission-gated, neutralises spreadsheet formulas, omits detail fields and is audited.
* **Maintenance mode** pauses customer sessions (503) but never staff or health checks.

## Phase 7 additions
* New permission `branches.manage` (Branch Manager, Bank Administrator, Super Administrator). Disputes, tickets and appointments use `support.manage`; requesting a reversal from a dispute additionally needs `transactions.adjust`.
* Customers can only read, attach to and download from their own tickets and disputes; another customer's id returns 404 and records a security event. Internal staff notes are never returned to customers.
* Uploads: 5 MB limit, PNG/JPEG/PDF only (by file signature, not name or declared type), client file names are sanitised, downloads are `nosniff` and `no-store`.

## Phase 8 additions
* Risk alerts need `risk.review`; system health needs `reports.read`; the staff notification inbox is open to any signed-in staff member and returns only their own rows. Resolving an alert needs a written note and is audited. No endpoint lets an alert block, freeze or reverse anything.
* AI: the customer chooses whether their spending totals may accompany a question; names, account numbers and long digit runs are never sent. The model cannot call any banking operation, and the prompt tells it to treat the question as data. Model output is shown as plain text and labelled as AI-written.
