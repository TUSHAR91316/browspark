import { expect, test } from 'bun:test';
import { highlightCode } from './highlight.js';

test('highlights setup snippets without changing their text or allowing HTML', () => {
  const config = JSON.stringify({ mcp: { browspark: { command: ['bun', '/a/"quoted"/index.ts'], enabled: true, disabled: false, optional: null, '<script>': '<img src=x onerror=alert(1)>&' } } }, null, 2);
  const commands = ['claude mcp add --transport stdio --scope user browspark -- bun "/my project/index.ts"', 'codex mcp add browspark -- bun "/a/index.ts"'];
  for (const code of [config, ...commands, '<script>alert("a&b")</script>']) {
    const html = highlightCode(code);
    expect(html.replace(/<span class="syntax-[a-z]+">|<\/span>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).toBe(code);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  }
  expect(highlightCode(config)).toContain('<span class="syntax-key">"command"</span>:');
  expect(highlightCode(config)).toContain('<span class="syntax-string">"bun"</span>');
  expect(highlightCode(config)).toContain('<span class="syntax-string">"/a/\\"quoted\\"/index.ts"</span>');
  expect(highlightCode(config)).toContain('<span class="syntax-literal">true</span>');
  expect(highlightCode(commands[0])).toContain('<span class="syntax-literal">--transport</span>');
  expect(highlightCode(commands[1])).toContain('<span class="syntax-command">codex</span>');
  expect(highlightCode(commands[1])).toContain('<span class="syntax-command">bun</span>');
});
