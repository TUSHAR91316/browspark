# Capability matrix

Probed live by `bun companion/test/capabilities.ts` on 2026-09-11.

- Extension mode: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 via chrome.debugger (extension v0.1.0)
- Developer mode: Chrome/152.0.7977.83 via direct CDP

| CDP domain | Extension mode | Developer mode |
|---|---|---|
| Runtime | ✅ | ✅ |
| Log | ✅ | ✅ |
| Network | ✅ | ✅ |
| Page | ✅ | ✅ |
| DOM | ✅ | ✅ |
| CSS | ✅ | ✅ |
| Debugger | ✅ | ✅ |
| DOMDebugger | ✅ | ✅ |
| Input | ✅ | ✅ |
| Emulation | ✅ | ✅ |
| Fetch | ✅ | ✅ |
| Overlay | ✅ | ✅ |
| Accessibility | ✅ | ✅ |
| Audits | ✅ | ✅ |
| Security | ❌ code:-32601,message:'Security.enable' wasn't found | ✅ |
| Profiler | ✅ | ✅ |
| HeapProfiler | ❌ code:-32601,message:'HeapProfiler.enable' wasn't found | ✅ |
| Tracing | ✅ | ✅ |
| Performance | ✅ | ✅ |
| Storage | ✅ | ✅ |
| DOMStorage | ❌ code:-32601,message:'DOMStorage.enable' wasn't found | ✅ |
| IndexedDB | ❌ code:-32601,message:'IndexedDB.enable' wasn't found | ✅ |
| CacheStorage | ✅ | ✅ |
| ServiceWorker | ❌ code:-32601,message:'ServiceWorker.enable' wasn't found | ✅ |
| Animation | ❌ code:-32601,message:'Animation.enable' wasn't found | ✅ |
| Media | ❌ code:-32601,message:'Media.enable' wasn't found | ✅ |
| WebAudio | ✅ | ✅ |
| WebAuthn | ✅ | ✅ |
| Target | ❌ code:-32000,message:Not allowed | ✅ |
| Browser | ❌ code:-32601,message:'Browser.getVersion' wasn't found | ✅ |

## What that means for the tools

| Tool | Extension mode | Developer mode |
|---|---|---|
| browser_* automation | ✅ shared tabs only | ✅ every tab |
| devtools_console, devtools_evaluate, devtools_network, devtools_sources, devtools_debugger, devtools_elements | ✅ | ✅ |
| devtools_storage | ✅ cookies via CDP, web storage via page JavaScript | ✅ |
| devtools_workers | ⚠️ registrations via the page; update/unregister via the page; skipWaiting/start/evaluate need developer mode | ✅ |
| devtools_performance (tracing) | ✅ | ✅ |
| devtools_profile (CPU) | ✅ | ✅ |
| devtools_memory (heap) | ❌ HeapProfiler not exposed to extensions | ✅ |
| devtools_coverage | ✅ | ✅ |
| devtools_emulation | ✅ | ✅ |
| devtools_accessibility, devtools_security | ✅ | ✅ |
| devtools_lighthouse | ❌ developer mode only | ✅ |
| devtools_cdp (raw commands) | ❌ developer mode only | ✅ |
| Browser-wide operations (Target, Browser, Storage domains) | ❌ not exposed to extensions | ✅ |
