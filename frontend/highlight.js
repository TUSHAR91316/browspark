const escape = (text) => text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);

export function highlightCode(code) {
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|--[\w-]*|\b(?:true|false|null|claude|codex|bun)\b/g;
  let html = '', end = 0;
  for (const match of code.matchAll(tokens)) {
    const token = match[0];
    const quoted = token[0] === '"' || token[0] === "'";
    const kind = quoted
      ? token[0] === '"' && /^\s*:/.test(code.slice(match.index + token.length)) ? 'key' : 'string'
      : /^(claude|codex|bun)$/.test(token) ? 'command' : 'literal';
    html += escape(code.slice(end, match.index)) + `<span class="syntax-${kind}">${escape(token)}</span>`;
    end = match.index + token.length;
  }
  return html + escape(code.slice(end));
}
