# Repository Guidelines

## Structure & Commands

This TypeScript/Playwright project automates Klook ticket selection.
`src/main.ts` orchestrates; `src/core/` owns strategy, types, state, and recovery;
`src/platforms/klook/` owns DOM interactions; `src/config/` owns configuration;
`tests/` contains tests; `docs/` records DOM observations.

From the repository root:

- `npm ci`: install locked dependencies.
- `npx playwright install chromium`: install test Chromium.
- `npm run typecheck`: check types.
- `npm test`: run tests.
- `npm start`: run the live flow in installed Chrome.

Review `src/config/event.config.ts` before live runs.

## Development & Style

- **Readability first:** Prefer simple, explicit code beginners can follow;
  prioritize clarity over brevity.
- **Single responsibility (SRP):** Give modules and functions one clear responsibility.
- **Avoid overengineering (YAGNI):** Add abstractions only for confirmed needs.
- **Context before changes:** Inspect callers, dependencies, types, tests,
  and upstream/downstream effects before editing.
- **Behavior-preserving refactoring:** Preserve behavior, validation checks,
  and flow boundaries.
- **Incremental development:** Work in verifiable steps within confirmed scope.
- **Clarify intent:** Ask about unclear requirements or expected behavior;
  decide routine implementation details independently.

Use four-space indentation, semicolons, existing quote style,
camelCase for functions/files, and PascalCase for classes/types.
Use strict TypeScript, `.js` relative imports, and `import type`.

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
and verify arrival at checkout and the expected amount. Stop before confirming
payment. Never retry contact submission or restart purchasing after an uncertain
submission result. Without contact configuration, stop on the contact page.

## Verification & Review

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

Base optional `contact.local.json` on `contact.example.json`.
Never commit personal data, secrets, or `browser-profile/`.
