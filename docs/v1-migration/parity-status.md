# V1 feature parity (Phase 11)

Checked against the V1 README and its 40 routes (`lib/features/*`). "Done" means built in V2, against the real backend, with tests. Nothing here
has been run on a physical device.

## Done (V1 had it, V2 now has it)
| V1 area | V2 |
| --- | --- |
| Splash, onboarding, login (username / email / customer ID), forgot / reset password, logout | Built earlier (server-side tokens; no fixed reset code) |
| PIN (4 or 6 digits), biometrics, app lock with 1 / 2 / 5 / 15 minute timeout, remember device | Built earlier; the PIN is verified by the server |
| **Two-factor sign-in** (V1: a prototype switch with no codes) | **New in Phase 11:** real authenticator-app codes, 8 single-use recovery codes, PIN + code to turn off |
| Dashboard: accounts, total balance, notification bell, balance privacy | Built earlier |
| **Dashboard quick actions, recent transactions, bottom navigation** | **New:** Transfer, Pay bills, Scan, Cards, More; five-tab bar (Home, Payments, Cards, History, Profile) |
| **Global search** (features, settings, saved recipients, transactions, session-only recent searches) | **New** |
| **Profile and edit personal details** | **New:** verified details read-only; email and phone editable with the PIN, audited, with a notice |
| **Settings:** theme, notification categories, show balances, lock timeout, reduce motion, **default payment account** | **New:** notification categories and default account are stored on the server and honoured by it (security alerts can never be muted) |
| **Transfer limits** (lower freely, raise with the PIN, never above the bank maximum) | **New:** enforced by the payment pipeline |
| **Transactions:** grouped by day, search, filters (**date, type, category, amount**, account), details, **repeat**, report | **New:** filters, grouping, detail screen and repeat (a fresh draft, still needs the PIN) |
| Transfers (own, saved recipient, new recipient, other bank fee LKR 25, scheduled), beneficiaries, bills (10 categories), QR pay and My QR, loan instalments | Built earlier |
| **Foreign-currency accounts** (V1 listed FX accounts) | **New:** USD / EUR / GBP accounts (no opening deposit), bank-quoted exchange valid for 60 seconds, two balanced single-currency ledger journals posted atomically, staff-set rates with a 20% change guard |
| Cards (debit, virtual, credit, controls, PIN, lost), fixed deposits, loans, **loan calculator**, savings goals, budgets | Built earlier; the calculator is **new** (estimate from the bank, labelled as not an offer) |
| **Analytics:** income, expenses, cash flow, **donut and net line** | **New:** donut, cash-flow bars with a net line, trend; each chart repeats its figures as text |
| Statements (CSV; PDF was not in V1) | Built earlier: PDF and CSV, English / Sinhala / Tamil, correct currency for foreign accounts |
| Notifications: categories, unread badge, mark read | **New:** filter chips and mark-one-read; mark-all existed |
| Support: FAQs, chat, **call / email / maps links**, branches and ATMs | Built earlier; **links and "near me" sorting are new** (location is requested only when tapped) |
| Disputes | Built earlier (with a staff queue, which V1 lacked) |
| **Offline banner** (payments paused), **maintenance screen**, **session expiry notice**, **error view with a support reference**, **crash handler** | **New** |
| Optional certificate pinning (`API_PINS`) | **New** (off unless built with pins) |
| Screenshot blocking (Android), no cloud backup, cleartext off in release | Built earlier |
| Accessibility tests (tap targets, labels, contrast) on every screen | Extended: light and dark themes, 2x text, reduced motion, on all new screens |

## Checklist round (V1 feature checklist, 22 sections)
Added after checking the list section by section. Everything below is built against the real backend with tests; none of it has been run on a device.

| Checklist item | V2 |
| --- | --- |
| Five-step registration | Personal, Contact, Sign-in, Identity, Review. Nothing is sent until the last step, then the profile and identity details go to the bank together. (V1's "banking" step has no equivalent: accounts are opened after staff verify identity.) |
| Reset by verification code | A 6-digit code, valid 30 minutes, tied to the username, 5 wrong guesses lock it. **Nothing delivers email or SMS yet**, so in development the code is shown on screen (`GET /dev/reset-code`, 404 elsewhere); staging and production have no delivery channel |
| Dashboard financial overview | This month's money in, spent and net on the home screen |
| Open an account with a deposit from another account | Chosen with the PIN at application; moved through the ledger when staff approve (the customer's amount, not what staff type). Rupee accounts only |
| Monthly money in/out per account, statements link, transfer from this account | On the account screen |
| Biometric payment authorisation | Opt-in. **Stores the app PIN in the phone's secure storage** (Keystore / Keychain) so a fingerprint can release it; the bank still verifies the PIN on every payment. Turned off on PIN change, sign-out and by the switch. This is a trade-off: the stored PIN is not itself gated by the fingerprint |
| Save recipient after a payment | Button on the receipt; the account number comes from the stored payment |
| Pending and failed payments; history type filter | Section on History; type filter (transfers, other bank, bills, QR, loan repayments, exchange) |
| Scheduled payments: completed and failed history | "Past runs" on the scheduled screen |
| Cards: carousel, permanent block | Swipeable cards; "Block card permanently" (PIN, no replacement; report-lost still orders one) |
| Home loan | Added (60 to 300 months, 10.50%) |
| Savings goals: target date, monthly auto-save | Both. Auto-save is approved once with the PIN, runs from the job tick once per month, never twice, and a shortfall skips that month and notifies |
| Eight spending categories, suggested budget, savings analysis | Food, Shopping, Transport, Bills, Entertainment, Health, Education, Other can be chosen on a transfer; they drive analytics, budgets and history. Suggested budgets (3-month average plus 5%). Savings rate in the monthly summary |
| Disputes: choose the transaction, "goods or services not received" | Added |
| Notification categories Offers and Bank notices; the listed alerts | New categories (Offers can be muted, Security cannot). New alerts: new recipient, PIN changed, password changed, device signed out, large transfer (threshold is a setting). Staff send offers and notices from the portal (Announcements) |
| Recent security alerts | On the security centre |
| Glass bottom navigation, glass sheets, fade/slide transitions, PIN shake | Blurred navigation bar; translucent sheets (not blurred); transitions and shake are off with reduce-motion |
| Data refresh when the connection returns | Home, notifications and insights reload |

Already there and unchanged: splash and onboarding, PIN and biometric unlock, app-switcher privacy cover, session expiry, QR camera permission handling and duplicate-scan protection, PDF receipt sharing, FD terms 3/6/12 months and 24-120 in 12-month steps.

### Checklist items NOT built
* Sample QR codes (a debug aid in V1); My QR and the demo customers cover testing.
* Customisable home widgets, push notifications, Sinhala/Tamil app screens (as before).
* Account approval screen for staff does not yet show "paid from the customer's account"; the API returns it (`paidFromAccountMinor`).

## Different on purpose
* **Registration** is five steps ending in identity verification (national ID, date of birth, address) that staff review; V1's mock steps had no review.
* **International transfers** were "unavailable" in V1; V2 offers currency exchange between your own accounts instead. Sending foreign currency abroad is not built.
* **Account switching:** V2 shows every account on the home screen rather than one selected account.
* **Receipts** are shared as PDFs (V1 saved text files).

## Not done
* **Customisable home widgets** (V1 matrix item "new" for V2): the home layout is fixed.
* Sinhala / Tamil **screens** (statements and receipts are translated, the app's own screens are English only, as in V1). The statement wording is unreviewed by a native speaker.
* Foreign-currency **payments** and cross-currency transfers to other people; foreign to foreign exchange (it goes through rupees).
* Push notifications to the phone (only a generic webhook exists on the server; the app has no token registration).
* Not run on any device or emulator by me beyond what you ran; all new screens are covered by widget tests only.
