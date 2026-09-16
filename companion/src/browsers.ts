import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type BrowserName = 'chromium' | 'chrome' | 'brave' | 'firefox' | 'zen';
export type BrowserEngine = 'chromium' | 'firefox';
export const browserEngine = (browser: BrowserName): BrowserEngine => browser === 'firefox' || browser === 'zen' ? 'firefox' : 'chromium';

const macApps = (...apps: string[]) => apps.flatMap(app => [join('/Applications', app), join(homedir(), 'Applications', app)]);
const windowsApps = (...apps: string[]) => apps.flatMap(app => [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.LOCALAPPDATA].filter((root): root is string => !!root).map(root => join(root, app)));
const candidates: Record<Exclude<BrowserName, 'chromium'>, Record<string, string[]>> = {
  chrome: {
    darwin: macApps('Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    win32: windowsApps('Google\\Chrome\\Application\\chrome.exe'),
  },
  brave: {
    darwin: macApps('Brave Browser.app/Contents/MacOS/Brave Browser'),
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave-browser-stable', '/usr/bin/brave', '/opt/brave.com/brave/brave', '/snap/bin/brave'],
    win32: windowsApps('BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
  },
  firefox: {
    darwin: macApps('Firefox.app/Contents/MacOS/firefox', 'Firefox Developer Edition.app/Contents/MacOS/firefox', 'Firefox Nightly.app/Contents/MacOS/firefox'),
    linux: ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/opt/firefox/firefox', '/snap/bin/firefox'],
    win32: windowsApps('Mozilla Firefox\\firefox.exe', 'Firefox Developer Edition\\firefox.exe', 'Firefox Nightly\\firefox.exe'),
  },
  zen: {
    darwin: macApps('Zen.app/Contents/MacOS/zen', 'Zen Browser.app/Contents/MacOS/zen'),
    linux: ['/usr/bin/zen-browser', '/usr/bin/zen', '/opt/zen-browser/zen', '/opt/zen/zen', join(homedir(), '.local', 'bin', 'zen')],
    win32: windowsApps('Zen Browser\\zen.exe', 'Zen\\zen.exe', 'Programs\\Zen Browser\\zen.exe'),
  },
};
const chromiumCandidates: Record<string, string[]> = {
  darwin: macApps('Chromium.app/Contents/MacOS/Chromium'),
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: windowsApps('Chromium\\Application\\chrome.exe'),
};

export function findBrowser(browser: BrowserName, explicit?: string): string {
  const env = `BROWSPARK_${browser === 'chromium' ? 'CHROME' : browser.toUpperCase()}`;
  const path = explicit ?? process.env[env];
  if (path) { if (existsSync(path)) return path; throw new Error(`${browser} not found at ${path}`); }
  // "chromium" is the existing engine selector: preserve its Chrome/Chromium discovery behavior.
  const paths = browser === 'chromium' ? [...candidates.chrome[platform()] ?? [], ...chromiumCandidates[platform()] ?? []] : candidates[browser][platform()] ?? [];
  for (const candidate of paths) if (existsSync(candidate)) return candidate;
  throw new Error(`Could not find ${browser}. Set ${env} or browserPath to the browser executable.`);
}
