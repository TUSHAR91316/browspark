# Browspark

Local MCP server that lets an AI agent operate websites and debug web applications in Chrome. Two connection modes:

- **Extension mode.** Drive tabs in your own Chrome, keeping their signed-in sessions. Only tabs you share from the extension dashboard are reachable.
- **Developer mode.** The companion launches Chrome with a dedicated persistent profile and talks CDP directly: every domain, raw commands, Lighthouse.

Developer tools are a first-class part of the product: Console, Network, Sources, Debugger, Elements, Performance, CPU and memory profiling, Application storage, service workers, coverage, emulation, accessibility, security, Lighthouse, and a recorder.

<p><img src="docs/images/dashboard-overview-dark.png" width="800" alt="Dashboard overview, dark theme"></p>

## Quick start

Requires [Bun](https://bun.sh) and a Chromium-based browser.

1. Register the companion with your MCP client. It is published on npm as [`browspark-mcp`](https://www.npmjs.com/package/browspark-mcp).

```bash
claude mcp add browspark -- bunx browspark-mcp@latest
```

2. Load the extension: clone this repo, run `bun install && bun run build`, then `chrome://extensions` → Developer mode → Load unpacked → the `extension/` folder.
3. Pair once: open the extension dashboard, ask the agent to call `browser_status`, paste the token it prints, and share the tabs the agent may use.

## Documentation

Setup for every client, the full tool reference, guides, and troubleshooting: **https://docs.browspark.krishm.dev/**

## Development

```bash
bun run typecheck
bun test                 # bridge unit tests
bun run test:e2e         # launches throwaway Chromes and runs the acceptance scenarios
bun run package          # dist/browspark-extension.zip
cd docs && bunx mint dev # preview the docs site
```

Layout: `companion/` (MCP server, transports, devtools modules), `extension/` (MV3 dashboard and worker), `shared/` (wire protocol), `docs/` (Mintlify site), `test-apps/` (deterministic pages).
