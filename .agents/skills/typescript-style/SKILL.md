---
name: typescript-style
description: >
  Use when writing, modifying, refactoring, or reviewing TypeScript code.
---

# TypeScript Style Guide

Keep types and coding style clear and consistent so code is easy to read and mistakes are easier to spot.

Follow existing project conventions and tool settings; use the preferences below where no explicit rule exists.
Do not rewrite existing code wholesale just to apply this guide.

## Naming and Formatting

1. **Use consistent names**: Use camelCase for variables and functions,
   and PascalCase for types, interfaces, and classes.
   Give booleans names that clearly express the condition, such as `isReady` or `hasPermission`.

2. **Keep formatting consistent**: When a formatter is available, follow the project's settings.
   Where no explicit settings exist, default to four-space indentation and semicolons, and follow the existing quote style.
   Whether or not a formatter is available, use braces when an `if` condition or body spans multiple lines.

3. **Prefer const**: Use `let` only when reassignment is needed.

## Type Principles

1. **Make types easy to understand**: Do not repeat type annotations for local variables whose types TypeScript can clearly infer.
   Add type annotations when a function's inputs or return value are unclear; follow existing project patterns.

2. **Check unknown data before using it**: Do not use `any` to hide problems.
   Use `unknown` for data whose type is uncertain, such as an unvalidated `JSON.parse` result,
   and check its contents before use.

3. **Do not simply assert that a type is correct**: Prefer conditional checks that narrow types.
   Do not casually add `as`, non-null assertions (`!`), double assertions (`as unknown as X`),
   or comments that suppress type checking just to remove errors. Type assertions do not replace runtime data checks.

4. **Follow existing type conventions**: Follow existing usage of `type` and `interface`; do not convert them in bulk based on preference.

5. **Use generics only when needed**: Use generics only when the same code genuinely needs to support different types
   while preserving relationships between those types.
   Do not add complex designs for hypothetical future uses.

6. **Handle states completely**: When each state needs separate handling, do not leave any out.
   When states carry different data, a shared field such as `kind` can distinguish them.
   In a `switch` that must handle every state, use a `never` check
   so adding a state without handling it produces a compile-time error.

## Imports and Missing Values

1. **Distinguish types from runtime uses**: Use `import type` for imports used only as types.
   Do not remove imports that are needed at runtime as a result.

2. **Follow the project's import setup**: Follow existing settings for path aliases, file extensions, and module syntax.
   Do not assume all projects use the same approach.

3. **Distinguish missing values from valid values**: Use `??` when a default is needed only for `null` or `undefined`.
   Do not treat valid values such as `0`, `false`, or an empty string as missing.
   For example, `count ?? 1` preserves `0`.

4. **Still check required data**: `?.` only stops further access when data is missing;
   a non-null assertion (`!`) performs no runtime check. Required data must still be checked after it is retrieved.
   Do not use these constructs to bypass missing-data problems.

## Asynchronous Code and Errors

1. **Keep asynchronous flows easy to follow**: Prefer `async`/`await` for ordinary flows.
   A `Promise` must be awaited, returned, or have explicit handling for background execution and errors.
   Using `void` to discard a `Promise` does not handle its failure.

2. **Do not use forEach to wait for asynchronous work**: Use `for...of` with `await` when work must be awaited in sequence.
   Consider `Promise.all` only when concurrent execution is safe; do not leave promises unhandled.

3. **Let error handling and cleanup wait for the result**: When returning a `Promise` inside `try`,
   use `return await` if the local `catch` needs to handle its failure
   or `finally` must wait for the operation to finish before cleaning up.

4. **Caught values are not necessarily Error objects**: Narrow the type with a check such as `error instanceof Error`
   before reading `message`. Preserve the original cause when wrapping errors;
   where the environment supports it, you can use `new Error("Message", { cause: error })`.
