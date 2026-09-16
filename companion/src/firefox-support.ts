// The Firefox adapter covers these operations; a tool name alone is not a parity claim.
export const FIREFOX_LIMITATIONS = [
  'Shared-tab extension mode (Firefox has no extension debugger API)',
  'Raw CDP, Lighthouse, live screencast',
  'Debugger breakpoints/stepping, Chrome traces, CPU profiles, V8 heap snapshots, precise coverage',
  'Matched CSS rules, box model, event listeners, forced pseudo states and DevTools overlays',
  'Browser accessibility trees, Chrome issue reports, TLS details, WebSocket/SSE frames',
  'Chrome device emulation, network throttling, worker debugging and service-worker bypass',
];

export const FIREFOX_DOMAINS: Record<string, string> = {
  Runtime: 'partial: evaluate, callFunctionOn, getProperties, object handles, console and exceptions',
  Page: 'partial: navigation, history traversal, screenshots, PDF, dialogs, frames, preload scripts',
  Input: 'partial: native mouse, keyboard and text input',
  DOM: 'partial: node lookup, search, HTML, attributes, file input',
  CSS: 'partial: computed styles and inline style edits through page objects',
  Network: 'partial: requests, responses, cache, cookies; response bodies depend on browser version',
  Fetch: 'partial: domain policies, blocking, mocks and response overrides',
  Log: 'partial: console messages and JavaScript exceptions',
  Storage: 'partial: cookies; web storage, IndexedDB and Cache Storage use page APIs',
  Browser: 'partial: lifecycle, tabs and downloads when supported by the browser',
  Debugger: 'unsupported: Firefox BiDi adapter does not expose debugger commands',
  Profiler: 'unsupported: Chrome CPU profiles and precise coverage',
  HeapProfiler: 'unsupported: V8 heap formats',
  Tracing: 'unsupported: Chrome tracing',
  Accessibility: 'unsupported: use devtools_accessibility action:check for DOM checks',
  Audits: 'unsupported: Chrome issue reports',
  Security: 'unsupported: certificate and connection security details',
  Emulation: 'unsupported: Chrome emulation',
  ServiceWorker: 'unsupported: use page-based list/update/unregister',
};

/** Guard operations whose Chromium handlers catch protocol errors or read unavailable event buffers. */
export function firefoxUnsupportedTool(name: string, args: Record<string, any>): boolean {
  if (['devtools_debugger', 'devtools_profile', 'devtools_memory', 'devtools_coverage', 'devtools_security', 'devtools_emulation'].includes(name)) return true;
  if (name === 'devtools_performance') return args.action !== 'vitals';
  if (name === 'devtools_accessibility') return args.action !== 'check';
  if (name === 'devtools_sources') return !(['override', 'overrides', 'revert'].includes(args.action) || args.action === 'list' && ['frames', 'contexts'].includes(args.kind));
  if (name === 'devtools_workers') return !['list', 'update', 'unregister'].includes(args.action);
  if (name === 'devtools_network') return ['frames', 'throttle'].includes(args.action);
  return false;
}
