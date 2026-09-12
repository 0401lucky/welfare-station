# Clover site UI directions

Created on 2026-09-11 for the user's requested visual and interaction refresh. Scope: home, account binding, personal records and non-game administration. Games remain outside the redesign.

## Review images

| Image | Actual dimensions | Purpose |
| --- | --- | --- |
| [Desktop home](home-desktop.png) | 1536 × 1024 | Compact clover-meadow hero, completed check-in, clear next draw action and coherent activity area. |
| [Mobile home](home-mobile.png) | 1024 × 1536 | Single-column direction, visible wallet context, compact completed check-in and collapsed calendar. |
| [Admin ledger](admin-ledger.png) | 1536 × 1024 | Compact operations workspace, existing section navigation, query controls, real pagination capability and distinguishable payout states. |
| [User style reference](user-style-reference.png) | 1341 × 1173 | Original image supplied by the user; preserved unchanged as a style source. |

## Generation provenance

- Model: `gpt-image-2.5` through the user's configured third-party Images API.
- Executed with the personal skill's `scripts/image_gen.py`, not a custom API runner.
- Desktop request used `edit --image user-style-reference.png` so the actual image bytes reached the provider.
- Mobile and administration requests used `edit --image home-desktop.png` to carry the same visual direction across layouts.
- All three requests used high quality and `--no-augment`; the exact prompts are [desktop](home-desktop-prompt.txt), [mobile](home-mobile-prompt.txt) and [administration](admin-ledger-prompt.txt).
- Each generation completed successfully and the saved image was visually inspected. Actual dimensions match the requested dimensions. No retries or provider/model substitutions were needed.
- Provider connection settings and credentials are not copied into this folder or into prompts.

## Interpretation and implementation boundaries

These are generated visual directions, not browser screenshots of completed product changes. Account names, amounts, dates, record rows and status examples are illustrative. Small generated glyphs, desktop step numbering and calendar highlights are not authoritative; production Chinese copy, calendar dates and financial states must be rendered from real frontend components and backend data.

The mobile image is a portrait composition study. The implemented pages have also been checked at real 375–390 px browser widths, including long identities and amounts. The admin table uses a bounded scroll area; actual query totals, page contents and disabled actions reflect the API.

Binding and personal records use the same reviewed visual system; their detailed states and constraints are documented in the task's `design.md` and research reports. Personal records do not inherit the admin-only filters or retry actions.

Runtime illustration: `hero-illustration.png`, generated with the same configured `gpt-image-2.5` edit CLI using `home-desktop.png` as the style reference and [the exact illustration prompt](hero-illustration-prompt.txt). Initial sandbox credential access and connection attempts failed; the subsequent request on the same configured route produced the inspected PNG. No model/provider or credential configuration was changed.

The runtime asset is `web/public/assets/site/clover-garden-hero.webp`: a 1536 × 512 crop of the source rectangle `(0, 340, 1536, 852)`, WebP quality 88, 44,788 bytes. It contains no text or controls. Existing clover/logo/icon SVGs remain in their native system. None of the full-page mockups are used as runtime pages.

## Implemented browser views

The following are actual local browser captures using controlled fixture data. All API calls were mocked; the pictured identities, balances and grants are not production records.

| Area | Browser capture |
| --- | --- |
| Home | [Desktop](implemented-home-desktop.png) · [Mobile](implemented-home-mobile.png) |
| Binding | [Desktop](implemented-bind-desktop.png) · [Mobile recovery state](implemented-bind-mobile.png) |
| Records | [Desktop](implemented-records-desktop.png) · [Mobile](implemented-records-mobile.png) |
| Administration | [Desktop ledger](implemented-admin-ledger-desktop.png) · [Mobile ledger](implemented-admin-ledger-mobile.png) |
| Financial/editing states | [Manual receipt](implemented-admin-manual-mobile.png) · [Activity dialog](implemented-admin-activity-mobile.png) |

Historical diagnostic captures `implemented-home-desktop-clean.png` and `admin-overflow-investigation.png` are retained for provenance; they show intermediate defects that were fixed and are not final review images.

Implementation and verification completed on 2026-09-12: 160 frontend tests, TypeScript/build and all Go tests passed. Controlled browser scenarios cover daily gating and date changes, binding/records recovery, ledger pagination, retained drafts, financial input and uncertain outcomes, keyboard/dialog behavior, permission revocation and 375–390 px layouts. All 37 protected game files and the retained administration game code remain unchanged. No deployment was performed.

The local Trellis task is `09-11-clover-ui-refresh`, under `.trellis/tasks/` while active and `.trellis/tasks/archive/2026-09/` after wrap-up. It contains `verification.md`, `qa/browser-results.json`, scenario scripts, the PRD and the design/execution documents.
