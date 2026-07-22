# Coding Standards

<!-- The reviewer agent loads this file during code review via
     @.sandcastle/CODING_STANDARDS.md so these standards are enforced during
     review without costing tokens during implementation. The authoritative
     project guidance lives in the repo root CLAUDE.md; keep this in sync. -->

## Style

- TypeScript, ESM (`"type": "module"`). `eslint .` (typescript-eslint `strict` +
  `stylistic`, prettier) must pass with zero warnings.
- No `any` (`@typescript-eslint/no-explicit-any` is an error outside tests).
- Prefer `import type` for type-only imports (`consistent-type-imports`).
- Prefix intentionally-unused bindings with `_`.

## Testing

- Vitest. New or changed behaviour needs a test; run `vitest run`.
- Keep unit tests fast and deterministic; integration/e2e tests live behind
  their own configs and env flags.

## Architecture

- This is a pnpm workspace (`packages/*`). Respect package boundaries: import
  across packages via their published entry points, not deep `../` paths.
- Keep modules focused on a single responsibility; prefer composition.
- Don't introduce new `pnpm run typecheck` errors — see #423 for the
  pre-existing backlog being paid down separately.
