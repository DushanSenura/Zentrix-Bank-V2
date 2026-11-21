# Mobile responsive audit

Method: every screen in the shared page list (`test/accessibility_test.dart`), plus the signed-in home, login and onboarding, was rendered
by `test/responsive_test.dart` at 8 viewports (320x568, 360x640, 390x844, 412x915, 600x960, 768x1024, 1024x1366, and 844x390 landscape)
and at text scales 1.0, 1.6 and 2.0 (light always, dark at 1.0 and 2.0). Any framework exception, including a RenderFlex overflow, fails the case.
1,008 cases; the home screen was tested with three accounts, a very long account name and a nine-digit balance.

## Defects found
| Screen | Problem | Severity | Fix |
| --- | --- | --- | --- |
| Notifications | "Mark all read" text button in the app bar overflowed at 320/360 wide with large text | Medium | Icon button with tooltip |
| Settings | Theme and lock-time dropdowns beside a title overflowed at 360 / 1.6x | Medium | Bounded, expanded dropdowns |
| Transaction history | Filters sat above a fixed list; overflowed on short screens (landscape) | High | Filters and results are one scrolling list |
| Transaction history | List tiles could not give way to a large amount (also at 2x text) | Medium | Custom row: name wraps, amount takes up to 40% |
| Home | Account card put the balance beside the name; a long name plus large balance overflowed | High | Balance under the name |
| Home | Five quick actions in one Row | Medium | Wrap grid: 3 per row under 340 dp, 5 above; rows grow with text |
| Onboarding | Fixed artwork and text overflowed at 320x568 and in landscape | High | Artwork shrinks, slide scrolls, width capped |
| All service pages | Content stretched across tablet widths | Low | `AdaptiveContent` centres a readable column (640 / 760 dp) |

## Added
`lib/core/responsive/adaptive.dart`: `ScreenClass` (compact under 360, standard, large from 600, expanded from 840) with gutters and maximum content width,
`AdaptiveContent`, `AdaptiveWrapGrid`. `ServicePage` uses `AdaptiveContent`.

## Not done (this was a targeted pass, not a full visual rebuild)
* No new visual design system: colours, typography and glass styling are the existing ones (blurred navigation bar and translucent sheets were added earlier).
* Not every screen has its own tablet multi-column layout; tablets get a centred column.
* No golden screenshots and no visual review by eye; checks are layout assertions only.
* Cards, registration, PIN sheet and bottom sheets with the keyboard open are covered by the earlier tests and the page list, not by the full matrix with the keyboard shown.
* Nothing was run on a device or emulator.
