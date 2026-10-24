# Repository Guidelines

## Communication

Before responding to the user, read and follow
[plain-chinese](.agents/skills/plain-chinese/SKILL.md).
Apply it to all user-facing responses, including progress updates,
clarifying questions, explanations, and final answers.

Use Traditional Chinese unless the user requests another language.
Read the skill once per conversation and apply it throughout.

## Structure & Commands

This TypeScript/Playwright project automates TicketPlus ticket purchases and lottery registration.
`src/main.ts` starts the local service and GUI, the only application entry point.
`src/server/` owns HTTP APIs and run management; `src/workers/` owns child-process
entry points and IPC; `src/storage/` owns activity persistence, data paths and purchase locks.
`src/app/platforms/` owns browser-free execution rules; `src/app/flows/` coordinates
platform flows; `src/platforms/` owns platform-specific browser interactions.
`src/config/` parses settings; `src/core/` owns shared sale-schedule validation;
`src/shared/` owns frontend-safe activity/run contracts and platform event schemas;
`src/gui/` owns the React frontend. `tests/` contains tests; `docs/` records DOM
observations and integration guides.

Platform settings register in `src/config/settingsRegistry.ts`, execution rules in
`src/app/platforms/executionRegistry.ts`, and child workers in `src/workers/workerRegistry.ts`.
GUI workspaces and run presenters register separately in
`src/gui/platforms/workspaceRegistry.ts` and
`src/gui/platforms/runPresenterRegistry.ts` to avoid circular imports.
See [adding a platform](docs/adding-platform.md) for contracts, compatibility,
lease responsibilities, and verification requirements.

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
Use lowercase platform directory names such as `ticketplus`, camelCase for ordinary
TypeScript files, and PascalCase for React components. Name registries for their
responsibility. Keep frontend helpers in `src/gui/shared/` and frontend/backend
contracts in `src/shared/`.
Use strict TypeScript and `.js` extensions for relative imports.

## Browser Flow & Recovery

Use observed DOM and behavior; verify results against target data, not button
availability alone. Stop with reasons for incomplete data, unknown states, or
failed validation; do not label these sold out.

Keep recovery separate from selection/form logic. Handle only recognized
exceptions with explicit triggers and completion conditions. Revalidate afterward
and reject expired seat/order data.

Preserve strict ticket matching. Never automatically retry seat confirmation.
Only skip explicitly sold-out ticket types. After a recognized sold-out response,
verify that the dialog is closed and the selection page is valid before trying
another configured priority. Refresh ticket quantities only after all priorities
are exhausted, and verify refresh completion before starting a new cycle.
Unknown responses, mismatches, and uncertain submission results stop the run;
never automatically resend or restart purchasing after an uncertain result.

For purchases, validate the information page, accept the terms, submit its next
step once, and verify arrival at checkout. Stop before confirming payment.
Currency and prices are checked manually by the user.
For lottery registration, wait for the user to fill participant details and
confirm in the GUI. Verify participant count and completion, submit the next
step once, then stop before final registration confirmation. Do not read, save,
or automatically fill participants' identity details.
TicketPlus uses the member profile for contact fields; runs require no contact
configuration and do not compare contact details.

Preserve existing request deduplication and persistent purchase locks. Archived
Klook data must remain unchanged and cannot be used to start new runs. Hiding
archived records must not release a lock or allow reuse of an existing request ID.

## Verification & Review

Work in verifiable steps within the confirmed scope.

Use `node:test`, `node:assert/strict`, and headless Playwright with local fixtures
or intercepted routes. Name tests `tests/<module>.test.ts`. Cover mismatches,
ambiguous selectors, timeouts, retry boundaries, and unintended clicks; close browsers.

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

Never commit personal data, secrets, `browser-profile/`, or `browser-profile-ticketplus/`.
Keep ignore rules for archived private contact and browser data.
