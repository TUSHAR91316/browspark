type GraphBrand = { name: string; label: string; src: string; darkSrc?: string };

const brands: Record<'agent' | 'browser', [RegExp, string, string, string?][]> = {
  agent: [
    [/^claude(?:[\s_/-]|$)/i, 'Claude', 'clients/claude.png'],
    [/^(?:openai[\s_-])?codex(?:[\s_/-]|$)/i, 'Codex', 'clients/codex.svg'],
    [/^cursor(?:[\s_/-]|$)/i, 'Cursor', 'clients/cursor.svg', 'clients/cursor-dark.svg'],
    [/^open[\s_-]?code(?:[\s_/-]|$)/i, 'OpenCode', 'clients/opencode.svg', 'clients/opencode-dark.svg'],
    [/^kilo(?:[\s_/-]|$)/i, 'Kilo', 'clients/kilo.svg'],
    [/^(?:google[\s_-])?antigravity(?:[\s_/-]|$)/i, 'Antigravity', 'clients/antigravity.png'],
  ],
  browser: [
    [/^(?:google\s+)?chrome(?:[\s/]|$)/i, 'Chrome', 'browsers/chrome.svg'],
    [/^brave(?:[\s/]|$)/i, 'Brave', 'browsers/brave.svg'],
    [/^helium(?:[\s/]|$)/i, 'Helium', 'browsers/helium.svg'],
    [/^vivaldi(?:[\s/]|$)/i, 'Vivaldi', 'browsers/vivaldi.png'],
    [/^arc(?:[\s/]|$)/i, 'Arc', 'browsers/arc.svg'],
    [/^dia(?:[\s/]|$)/i, 'Dia', 'browsers/dia.png'],
    [/^(?:mozilla\s+)?firefox(?:[\s/]|$)/i, 'Firefox', 'browsers/firefox.png'],
    [/^tor(?:[\s/]|$)/i, 'Tor', 'browsers/tor.svg'],
    [/^zen(?:[\s/]|$)/i, 'Zen', 'browsers/zen.svg'],
  ],
};

// Match reported products; unidentified browsers get their engine's mark.
export function graphBrand(name: string, kind: 'agent' | 'browser', engine?: 'chromium' | 'firefox'): GraphBrand {
  const match = brands[kind].find(([pattern]) => pattern.test(name.trim()));
  if (match) return { name: match[1], label: name.trim(), src: `assets/${match[2]}`, ...(match[3] ? { darkSrc: `assets/${match[3]}` } : {}) };
  if (kind === 'agent') return { name: 'Other agent', label: 'Other agent', src: 'assets/clients/other-agent.svg' };
  // Older companions omit engine metadata; retain their Firefox-based name hint.
  const firefox = engine ? engine === 'firefox' : /^(?:mozilla\s+)?firefox\b/i.test(name.trim());
  const label = firefox ? 'Unknown Firefox' : 'Unknown Chromium';
  return { name: label, label, src: firefox ? 'assets/browsers/firefox.png' : 'assets/browsers/chromium.png' };
}
