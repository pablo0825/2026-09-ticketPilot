---
name: readable-code
description: >
  Use when writing, modifying, refactoring, or reviewing code.
---

# Readable Code Guide

Write code that beginners can understand, maintain, and extend:
make the main flow clear at a glance, give each function a clear responsibility,
and combine functions as needed.

Follow existing project conventions; they take precedence when they conflict with this guide.
When several approaches work, choose the one that is easiest to understand.

## Coding Principles

1. **Keep it simple and direct**: Use straightforward code. Do not cram logic together just to reduce line count.
   Solve current requirements without adding unnecessary features or complex designs in advance.
   When conditionals become deeply nested, first consider handling unmet conditions with early returns
   to keep the main flow easy to read.

2. **Separate the main flow from the details**: Make the main flow clearly show the steps.
   Put each step's details in a function with a clear responsibility, then combine those functions in the main flow.
   Coordinating these steps is itself a clear responsibility.

   ```ts
   function createReport(rawRows: Row[]): string {
       const validRows = removeInvalidRows(rawRows);
       const totals = sumByCategory(validRows);

       return formatReport(totals);
   }
   ```

   Reading the main flow should show how the report is created; inspect individual functions when you need the details.

3. **Leave a blank line between different steps**: Keep code that does the same thing together,
   and leave a blank line when moving to the next step. For example, checking whether an action can proceed,
   validating data, sending a request, and updating the UI should be separated by blank lines.
   This applies even to short functions, but you do not need a blank line between every line of code.

4. **Make responsibilities clear**: Give each function one job that can be clearly described.
   If it mixes work serving different purposes, extract that work when doing so makes the code easier to understand or modify.

5. **Split code where it helps**: Split code to make it easier to understand, modify, or reuse, not merely because it has many lines.
   Related small functions can stay in the same file to avoid constant navigation while reading.

6. **Use clear names**: Function names should describe what they do; variable names should describe what they hold.
   Avoid obscure abbreviations and names that hide their purpose.

7. **Use comments to aid understanding**: For longer flows or flows with multiple steps, use short Chinese comments to explain each section's purpose.
   Explain the reasons behind non-obvious code; do not restate the code line by line.

## Change Principles

1. **Change only what is needed**: Every change should serve the current task. Do not refactor or rearrange unrelated code along the way.

2. **Preserve existing behavior**: When refactoring, preserve inputs, outputs, validation, error handling, and necessary operation order.
   Do not accidentally add, omit, or repeat operations such as writing files or sending requests. State explicitly when behavior needs to change.

3. **Do not hide problems**: Do not use default values or empty catch blocks to conceal errors.
   Do not weaken validation or skip tests just to make checks pass.

4. **Ask when clarification matters**: Clarify uncertainties that affect requirements or externally observable behavior.
   Decide routine implementation details independently, following existing project patterns.

5. **Keep reviews separate from edits**: When the user asks only for a review, provide evidence-based findings and suggestions without making changes.

6. **Briefly explain changes**: When finished, summarize what changed.
   If you split code into smaller parts, explain why. Also identify anything not yet verified.

## Testing Principles

1. **Protect important behavior**: Prioritize tests for important logic such as input validation, calculations, and state changes.
   Cover normal cases as well as error-prone boundary and failure cases.

2. **Guard against recurring bugs**: When fixing a bug, add a test where feasible that catches the issue before the fix and passes after it.

3. **Test outcomes without locking in the implementation**: Check that results and behavior match expectations,
   without requiring specific internal variables or a fixed number of functions.
   Not every small function needs its own test, and tests should not be added solely to increase coverage.

4. **Use existing tools and verify changes**: Use the project's existing tools and run relevant checks after making changes.
   Briefly state what the checks covered and which checks were not run or did not pass.
   Do not introduce a new testing framework for a small change; changes that do not affect behavior may use lighter checks.
