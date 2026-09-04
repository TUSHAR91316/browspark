// Fetch-domain interception shared by network mocks, sources overrides, and the navigation policy (allowed/blocked domains).
import type { Sessions } from '../session.ts';

export interface Policy { allow?: string[]; block?: string[] }
export const policies = new Map<number, Policy>();
/** Applied automatically to tabs the agent opens (browser_tabs new, browser_fetch). */
export let defaultPolicy: Policy | undefined;
export const setDefaultPolicy = (p?: Policy) => { defaultPolicy = p; };

const fetchOn = new Set<number>();
const norm = (d: string) => d.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const matches = (host: string, d: string) => { const n = norm(d); return !!n && (host === n || host.endsWith('.' + n)); };

/** true when the policy lets this URL through. Non-http(s) schemes (data:, blob:, about:) are always allowed. */
export function allowedByPolicy(url: string, p: Policy): boolean {
  let host: string; try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return true; host = u.hostname.toLowerCase(); } catch { return true; }
  if (p.block?.some((d) => matches(host, d))) return false;
  if (p.allow?.length) return p.allow.some((d) => matches(host, d));
  return true;
}

/** (Re)apply Fetch interception for a tab from its override patterns plus the policy. Disables Fetch when nothing needs it. */
export async function applyFetch(sessions: Sessions, tabId: number, overridePatterns: string[]): Promise<boolean> {
  const patterns = overridePatterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
  if (policies.get(tabId)) patterns.push({ urlPattern: '*', requestStage: 'Request' });
  if (!patterns.length) { if (fetchOn.has(tabId)) { await sessions.cdp(tabId, 'Fetch.disable').catch(() => {}); fetchOn.delete(tabId); } return false; }
  await sessions.cdp(tabId, 'Fetch.enable', { patterns });
  fetchOn.add(tabId);
  return true;
}
export const forgetTab = (tabId: number) => { fetchOn.delete(tabId); policies.delete(tabId); };
