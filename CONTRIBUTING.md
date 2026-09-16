# Contributing to Browspark

Thanks for helping. Browspark is small and moves fast, so the rules are short.

## Before you start
- Search [existing issues](https://github.com/uncaughterrs/browspark/issues) first. Bugs need steps to reproduce, the browser and version, and the client you use (Claude Code, Codex, Cursor…).
- For anything larger than a bug fix, open an issue describing the change before writing code. It saves both of us from a pull request that cannot land.

## Setup
Browspark uses [Bun](https://bun.sh) for everything: install, run, bundle and test. There is no Node or npm step.

```bash
bun install
bun run build        # extension bundles
bun run typecheck
bun run --cwd frontend build # required before the landing-page smoke tests
bun test             # unit, bridge and landing-page tests; no browsers
bun run test:e2e     # launches throwaway Chromium browsers
bun run test:firefox # Firefox acceptance scenarios
bun run test:multi-browser # Chrome, Brave, Firefox and Zen together
```

Load `extension/` unpacked in Chrome or Brave and run the companion from source with `bun companion/src/index.ts`. Multiple profiles can connect to the same companion. Firefox and Zen use separate developer contexts without an extension. Install the required browsers before running their acceptance suites, and run browser suites one at a time. See the [development reference](https://docs.browspark.krishm.dev/reference/development) for executable overrides and the full workflow.

## Pull requests
- Keep each pull request to one change. Small diffs get reviewed quickly.
- Match the existing style: TypeScript, no frameworks, no new dependencies unless a few lines cannot do the job.
- Run `bun run typecheck` and `bun test` before pushing. Add or update a test when you change behavior.
- Tool changes must keep the tool descriptions accurate, since agents read them. Run `bun run docs:tools` to regenerate the tool docs.
- Use conventional commit messages: `feat(extension): …`, `fix(companion): …`, `docs: …`.

## Reporting security issues
Do not open a public issue for security problems. Email the maintainer instead and allow time for a fix before disclosure.

## License
By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
