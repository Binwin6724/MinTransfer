# Contributing to MinTransfer

Thanks for helping! A few rules keep people's data safe.

## Getting started

```bash
npm install
npm test        # unit + integration tests
npm run dev     # Vite + Electron with live reload
```

## Rules for changes

1. **Never lose data.** Backups are read-only to everything except the code that creates them. Extraction
   always writes to a new folder. Anything destructive needs an explicit confirmation in the UI and a check
   in the main process.
2. **No shells.** Run tools with `run()` from `electron/exec.ts` and an argument array. Anything that ends
   up inside an Android shell command must go through `shQuote()` or a strict validator.
3. **No secrets on disk or on command lines.** Backup passwords are passed via environment variables and
   never logged or stored.
4. **Honest messages.** If Android or iOS blocks something, say so; don't fake progress or results.
5. Keep `shared/` free of Electron and Node so it stays unit-testable, and add tests for new parsers.

## Regenerating assets

```bash
swift scripts/make-icons.swift build                   # app icon (macOS)
npm run build && npx electron . --capture-screenshots docs/images   # README screenshots
```
