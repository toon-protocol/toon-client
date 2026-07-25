---
'@toon-protocol/views': patch
---

Declare `@testing-library/dom` as an explicit devDependency.

It is a required peer of `@testing-library/react@16` and was only resolvable
because `packages/rig-web` happened to declare it. With rig-web removed from
this workspace, views' own test suite could no longer resolve it (18 failed
suites: `Cannot find module '@testing-library/dom'`, plus 40 `TS2305` errors
for the re-exported `screen`/`fireEvent`/`waitFor`/`within` bindings).
No runtime or published-output change.
