# Repository Guidelines

## Communication

Before responding to the user, read and follow
[plain-chinese](.agents/skills/plain-chinese/SKILL.md).
Apply it to all user-facing responses, including progress updates,
clarifying questions, explanations, and final answers.

Use Traditional Chinese unless the user requests another language.
Read the skill once per conversation and apply it throughout.

## Structure & Commands

This TypeScript/Playwright project automates ticket selection on Klook and TicketPlus.
`src/local/main.ts` starts the GUI, the only entry point; `src/app/` orchestrates
purchase runs; `src/core/` owns strategy, types, state, and recovery;
`src/platforms/` owns platform-specific browser interactions; `src/config/` owns configuration;
`tests/` contains tests; `docs/` records DOM observations.

From the repository root:

- `npm ci`: install locked dependencies.
- `npx playwright install chromium`: install test Chromium.
- `npm run typecheck`: check types.
- `npm test`: run tests.
- `npm run format`: format files with Prettier; run before committing.
- `npm run gui`: open the local GUI; live runs use installed Chrome.

Review the activity settings in the GUI before live runs.

## Development & Style

Before writing, modifying, refactoring, or reviewing code, read and follow:

- [readable-code](.agents/skills/readable-code/SKILL.md) for clear code structure and focused changes.
- [typescript-style](.agents/skills/typescript-style/SKILL.md) for TypeScript style and practices.

This repository's rules take precedence over these guides.

Follow existing file naming conventions, including PascalCase for React component files.
Use strict TypeScript and `.js` extensions for relative imports.

## Browser Flow & Recovery

Use observed DOM and behavior; verify results against target data, not button
availability alone. Stop with reasons for incomplete data, unknown states, or
failed validation; do not label these sold out.

Keep recovery separate from selection/form logic. Handle only recognized
exceptions with explicit triggers and completion conditions. Per run, allow one
independent queue recovery and one reservation recovery shared by seat and contact
expiry, regardless of order. During reservation recovery, allow one additional
queue-expiry handling step on the return to the event page. This allows at most
two top-level recoveries and three recovery-dialog click attempts. Consume each
budget before acting; never reset budgets on a rerun. A failed recovery stops
rather than falling back to another budget. Revalidate afterward and reject
expired seat/order data.
Preserve strict ticket matching. Never automatically retry seat confirmation.
After verifying the booking summary and configured contact details, submit once
and verify arrival at checkout. Currency and prices are checked manually by the user. Stop before confirming
payment. Never retry contact submission or restart purchasing after an uncertain
submission result. For Klook, require valid contact configuration before opening the browser; missing
or invalid contact data stops startup before ticket selection.
Contact configuration and contact-detail checks apply only to Klook. TicketPlus
fills contact fields from the member profile, so TicketPlus runs neither
require `contact.local.json` nor compare contact details.

## Verification & Review

Work in verifiable steps within the confirmed scope.

Use `node:test`, `node:assert/strict`, and headless Playwright with local fixtures
or intercepted routes. Name tests `tests/<module>.test.ts`. Cover mismatches,
ambiguous selectors, timeouts, recovery limits, and unintended clicks; close browsers.

After code changes, run typechecking and relevant tests, then obtain one independent
subagent review of readability, single responsibility, compatibility, and regressions.
Address confirmed review issues and rerun relevant checks.
Documentation-only changes need no subagent review.
Report reasons, scope, results, and uncertainties; distinguish local tests from
live-site verification.

## Commits & Private Data

Use Conventional Commits: `<type>(<scope>): <summary>`.
Use focused commits, imperative summaries, and module scopes,
e.g. `fix(seats): reject mismatched quantities`. Separate unrelated refactoring.

After implementation or edits, automatically commit task-related changes once
required verification and review pass. Stage only changes made for the current task;
leave unrelated changes uncommitted. Report the commit hash when finished.

Base the Klook `contact.local.json` on `contact.example.json`.
Never commit personal data, secrets, or `browser-profile/`.
