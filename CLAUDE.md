# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the coding style, naming and PR conventions; follow it. This file covers what is not obvious from reading one file: how the pieces fit, the invariants, and the release checklist.

## Commands

Bun for everything (no node/npm/npx). Run from the repo root.

```bash
bun install
bun run build                # bundle extension worker + dashboard → extension/dist/ (reload extension after)
bun run typecheck            # tsc for companion, extension and shared
bun test                     # unit + bridge tests only (no Chrome)
bun run test:e2e             # E2E=1: launches throwaway Chromes; build the extension first
bun test companion/test/unit.test.ts            # one file
E2E=1 bun test companion/test/devtools.e2e.test.ts -t "breakpoint"   # one e2e scenario by name
bun run docs:tools           # regenerate docs/tools/** and docs/docs.json groups from live tool registrations
bun run capabilities         # regenerate docs/reference/capability-matrix.mdx (launches two Chromes)
bun run package              # dist/browspark-extension.zip (the release asset)
bun run --cwd frontend build # landing page → frontend/dist (also copies root setup.sh); run before root tests
bun run --cwd frontend test  # landing page smoke tests
cd docs && bunx mint dev     # preview docs; bunx mint broken-links to validate
bash setup.sh --test         # dry-run the installer
```

E2E needs Chrome at `/Applications/Google Chrome.app/...` or `CHROME=<path>`. E2E tests are slow and spawn browsers: never run two e2e invocations at once, and kill stray Chromes if a run is interrupted.

## Architecture

Two processes, one wire protocol:

- **Companion** (`companion/src`, `bunx browspark-mcp@latest`): the MCP server. Speaks MCP over stdio to the launching client and, always, Streamable HTTP at `http://127.0.0.1:9223/mcp?token=…`. Owns the WebSocket bridge the extension connects to on the same port.
- **Extension** (`extension/`, MV3, no host permissions): a service worker that attaches `chrome.debugger` to tabs the user shared, plus a framework-free dashboard.
- `shared/protocol.ts` is the contract: `Req/Res/Evt` over one socket, `PROTOCOL_VERSION`, `ReqMethod` names, and the two predicates both sides use (`isNewTab`, `unsupportedReason`).

Two ways to reach a page, hidden behind one layer:

- **Extension mode**: companion → bridge `cdp` request → worker → `chrome.debugger.sendCommand` on a shared tab.
- **Developer mode**: companion launches its own Chrome (`cdp.ts`, `DirectChrome`, persistent profiles under `~/.browspark`) and speaks CDP directly. Dev tab ids come from a companion-wide counter and share the id namespace with `chrome.tabs` ids.

`session.ts` (`Sessions`) is the only place that knows which mode a tab is in: `modeOf`/`cdp` fork on it, and `resolve(tabId?)` is where "which tab" is decided (explicit id must be shared and supported; no id → this agent's most recent tab, else the single usable tab, else an error listing candidates). Everything above it (`page.ts`, `tools.ts`, `devtools/*`) is mode-agnostic and only calls `sessions.cdp` or `ctx.page`.

Tool call path: MCP → `tool()` wrapper in `context.ts` (sets the current agent via `AsyncLocalStorage`, checks the disabled list, normalises errors) → `sessions.resolve` → `page.*` / `sessions.cdp` → mode-specific transport. CDP events flow back on one `cdp.event` stream consumed by `page.ts` (dialogs, loads) and `devtools/capture.ts` (ring buffers per tab).

Multi-agent: each MCP transport gets its own `McpServer` + `ClientState` (name, owned tabs, recording), while `Sessions`, `Page` and `Capture` are shared. If port 9223 is taken, a second companion becomes a stdio→HTTP relay to the first instead of failing, so every agent ends up on one extension. `devtools_session` is shared between agents and only tears down when the last user stops.

Key files when something misbehaves:
- `companion/src/index.ts` wiring and relay; `bridge.ts` token, handshake close codes (4001 no hello, 4002 version, 4003 token), one extension at a time.
- `companion/src/page.ts` snapshot/refs (`window.__bmcp`, refs never reused, wiped on navigation), dialog racing, New Tab `tabs.prepare` dance.
- `companion/src/devtools/capture.ts` session start/stop; `intercept.ts` is the single owner of the Fetch domain (policies, mocks, overrides).
- `extension/src/background.ts` the trust boundary: `isShared` is checked on every command and again after attach; idle detach after 30 s unless held by a session; tabs are activated before input/screenshots.
- `extension/src/app.ts` polls the worker every second and re-renders through a DOM morph; `state.ts` is the dashboard↔worker contract.

## Invariants to preserve

- The extension, not the companion, enforces sharing. Never add a companion path that bypasses `isShared`.
- Anything a devtools tool changes in the browser (emulation, overrides, breakpoints, tracing) must push an undo closure onto `st.cleanups` so `devtools_session stop` reverts it.
- Refs are stable until navigation; tools must tell the agent to re-snapshot rather than guess.
- Tool descriptions are read by agents and by the docs generator. Error messages containing "developer mode" / "Not allowed" / "wasn't found" feed the `devGate` that permits launching a dev browser in `auto` mode, so keep that wording.
- Large results go through `artifacts.ts` (`~/.browspark/artifacts`), never inline.
- Only the main tab session's CDP events are captured; events with a `sessionId` (workers, OOPIFs) are ignored by design.

## Adding or changing a tool

1. Register with `tool(ctx, name, description, zodShape, handler)` from `context.ts`, in `tools.ts` (`browser_*`) or a `devtools/*.ts` registrar (`devtools_*`). Never call `server.registerTool` directly.
2. A new registrar module must be added in two places: `companion/src/index.ts` and `companion/test/docs.ts`.
3. Add an example to `companion/test/docs-examples.ts` (schema-validated; the generator exits 1 on a mismatch), then `bun run docs:tools`.
4. Need a `chrome.*` API rather than CDP? Add a `ReqMethod` in `shared/protocol.ts`, a branch in `background.ts` `handle()` with an `isShared` check, and bump `PROTOCOL_VERSION` if old extensions would break.
5. Cover it in `devtools.e2e.test.ts` or `e2e.test.ts` against `test-apps/`.
6. Check the landing page's tool counts (`frontend/index.html`: total, browser, devtools) still match.

## Release checklist

Any feature, tool, or installation change must be reflected everywhere users see it, in this order:

1. **Docs** (`docs/`): the tool page via `bun run docs:tools`, plus the relevant guide. Installation changes go in `docs/get-started/quickstart.mdx` (Option 1 script, Option 2 manual) and `installation.mdx`.
2. **README.md**: keep it to the quick start; detail lives on the docs site. Installation is Option 1 (`setup.sh`) and Option 2 (manual).
3. **Landing page** (`frontend/`): install steps, setup one-liner, tool counts, meta. Run `bun run --cwd frontend test`.
4. **`setup.sh`**: any change to how the companion is run or where the extension comes from. Verify with `bash setup.sh --test`.
5. **Versions**, kept identical: `package.json`, `aliases/browspark/package.json`, `extension/manifest.json`. Then `bun run package` for the zip.
6. **Publish**: `bun run release` publishes `browspark-mcp` and the `browspark` alias to npm. Create a GitHub release tagged with the version and attach `dist/browspark-extension.zip`; `setup.sh` and the docs download from `releases/latest`.
7. **Deploys are automatic on push to `main`**: Mintlify (docs, `docs/` subdirectory), Cloudflare Workers (landing page from `frontend/`, config in `frontend/wrangler.jsonc`).

Data dir and env vars are `~/.browspark` and `BROWSPARK_*`; the pairing token lives in `~/.browspark/token` and moving the dir forces users to re-pair, so call that out in release notes.
