---
'@toon-protocol/client': patch
---

Fix `toon` being a silent no-op through its `bin` link.

`package.json` points `bin` at `dist/cli/main.js`, so npm links
`node_modules/.bin/toon` at it — and Node then reports `import.meta.url` as the
realpath while `process.argv[1]` is the link. The entry guard compared those two
strings, decided this file was not the program, and exited 0 having run nothing.
That silence is the dangerous half: a script checking `$?` saw green. It affected
every documented way to run the command — `npx toon`, a global install, and a
project's `node_modules/.bin/toon` — leaving the real built path as the only one
that worked.

Both sides are now resolved through their symlinks before they are compared.
