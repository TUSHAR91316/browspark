<div align="center">
    <img src="docs/images/logo.png" title="Browspark" alt="Browspark logo" width="120" />
    <h1>Browspark</h1>
    <p>
        Give your AI agent a real browser.
        <br>
        A local MCP server and Chrome extension for operating and debugging websites, with the full developer toolbox built in.
    </p>
    <a href="https://browspark.krishm.dev/">Website</a>
    ·
    <a href="https://docs.browspark.krishm.dev/">Documentation</a>
</div>

## Install
> [!NOTE]
> Browspark is in early release. If something breaks, please [open an issue](https://github.com/uncaughterrs/browspark/issues).

Requires [Bun](https://bun.sh) and a Chromium-based browser (Chrome, Brave, Edge).

### Option 1: one command

Downloads the extension, registers the companion with the agents you pick, and walks you through pairing. Add `--test` for a dry run that changes nothing.

```bash
curl -fsSL https://browspark.krishm.dev/setup.sh | bash
```

### Option 2: by hand

**1. Register the companion** with your MCP client. It is published on npm as [`browspark-mcp`](https://www.npmjs.com/package/browspark-mcp); no clone needed.

```bash
claude mcp add browspark -- bunx browspark-mcp@latest
```

Codex, OpenCode, Cursor, Kilo and Antigravity are covered in the [connect guide](https://docs.browspark.krishm.dev/connect/agents).

**2. Get the extension.** Download `browspark-extension.zip` from the [latest release](https://github.com/uncaughterrs/browspark/releases/latest) and unzip it, or clone this repo and run `bun install && bun run build` to use the `extension/` folder. Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select that folder.

**3. Pair once.** Open the extension dashboard, ask the agent to call `browser_status`, paste the token it prints, and share the tabs the agent may use.

## What it does
- **Extension mode.** The agent drives tabs in your own browser, keeping your signed-in sessions. Only tabs you share are reachable, and you can revoke access instantly.
- **Developer mode.** The companion launches a separate Chrome with a persistent profile and talks CDP directly: every domain, raw commands, Lighthouse.
- **Developer tools as first-class tools.** Console, Network, Sources, Debugger, Elements, Performance, CPU and memory profiling, storage, service workers, coverage, emulation, accessibility, security, Lighthouse and a recorder that exports Playwright tests.

The full tool reference is at [docs.browspark.krishm.dev/tools](https://docs.browspark.krishm.dev/tools/overview).

<p align="center"><img src="docs/images/dashboard-overview-dark.png" width="800" alt="Dashboard overview, dark theme"></p>

## Development
```bash
bun install
bun run build            # extension bundles → extension/dist/
bun run typecheck
bun test                 # bridge unit tests
bun run test:e2e         # launches throwaway Chromes and runs the acceptance scenarios
bun run package          # dist/browspark-extension.zip
cd docs && bunx mint dev # preview the docs site
```

Layout: `companion/` (MCP server, transports, devtools modules), `extension/` (MV3 dashboard and worker), `shared/` (wire protocol), `docs/` (Mintlify site), `frontend/` (landing page), `test-apps/` (deterministic pages for tests).

## Contributing
Before contributing, please read the guidelines in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

### We believe in open source
Browspark exists because other people published their work for anyone to build on, and it is published under the same terms. Every line of the companion, the extension, the docs and the landing page is in this repository, so you can read exactly what runs on your machine and what touches your browser.


### Model Context Protocol
The tools and the server are built on the [Model Context Protocol](https://modelcontextprotocol.io) and its TypeScript SDK. MCP is what lets one companion serve Claude Code, Codex, Cursor and every other client through the same interface.


### Chromium
Everything Browspark does in the browser goes through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) and the extension `debugger` API. The developer tools it exposes are the same ones the DevTools panels use.


### Supabase
The dashboard and landing page take their visual direction from [Supabase](https://supabase.com): a neutral dark palette, a single green accent, and interfaces that stay out of the way. Thanks for showing that developer tools can be calm and good looking.


## License
Browspark is licensed under the MIT License. See [LICENSE](LICENSE).
