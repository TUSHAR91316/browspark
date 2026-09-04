import { highlightCode } from './highlight.js';

document.documentElement.classList.add('js');

const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
const closeMenu = () => { menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); };
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });

for (const button of document.querySelectorAll('[data-preview]')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-preview]')) {
      const selected = item === button;
      item.setAttribute('aria-pressed', String(selected));
      document.querySelector(`#preview-${item.dataset.preview}`).hidden = !selected;
    }
  });
}

for (const input of document.querySelectorAll('[data-share]')) {
  input.addEventListener('change', () => {
    const count = document.querySelectorAll('[data-share]:checked').length;
    document.querySelector('#shared-count').textContent = count;
    document.querySelector('#nav-tab-count').textContent = count;
    const permission = input.closest('.demo-tab').querySelector('.tab-permission');
    permission.textContent = input.checked ? 'Shared' : 'Private';
    permission.classList.toggle('private', !input.checked);
    document.querySelector('#demo-result').textContent = `${count} ${count === 1 ? 'tab' : 'tabs'} available to your agent`;
  });
}

const pkg = 'browspark-mcp@latest';
const stdio = { command: 'bunx', args: [pkg] };
const local = JSON.stringify({ mcp: { browspark: { type: 'local', command: ['bunx', pkg], enabled: true } } }, null, 2);
const clients = {
  claude: { name: 'Claude Code', file: 'Terminal', instruction: 'Run this command in your terminal to register Browspark for all your projects.', code: `claude mcp add --transport stdio --scope user browspark -- bunx ${pkg}`, next: 'Start a new session, then check /mcp.', docs: 'https://code.claude.com/docs/en/mcp' },
  codex: { name: 'Codex', file: 'Terminal · Codex CLI', instruction: 'Run this command in your terminal. Codex saves the server in ~/.codex/config.toml.', code: `codex mcp add browspark -- bunx ${pkg}`, next: 'Restart your Codex client, then check MCP settings.', docs: 'https://developers.openai.com/codex/mcp/' },
  opencode: { name: 'OpenCode', file: '~/.config/opencode/opencode.json', instruction: 'Add this entry to your global OpenCode config, keeping any existing servers.', code: local, next: 'Restart OpenCode, then run opencode mcp list.', docs: 'https://opencode.ai/docs/mcp-servers/' },
  cursor: { name: 'Cursor', file: '~/.cursor/mcp.json', instruction: 'Add this entry to your global Cursor config, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: { type: 'stdio', ...stdio } } }, null, 2), next: 'Restart Cursor, then enable the server in Customize → MCP.', docs: 'https://cursor.com/docs/mcp' },
  kilo: { name: 'Kilo', file: '~/.config/kilo/kilo.jsonc', instruction: 'Add this entry to your global Kilo config, keeping any existing servers.', code: local, next: 'Open Settings → MCP in Kilo and enable Browspark.', docs: 'https://kilo.ai/docs/automate/mcp/using-in-kilo-code' },
  antigravity: { name: 'Antigravity', file: 'mcp_config.json', instruction: 'Open the Agent panel → … → MCP Servers → Manage MCP Servers → View raw config. Add this entry, keeping existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Save, then check Browspark in MCP management.', docs: 'https://antigravity.google/docs/mcp' },
};
function chooseClient(id) {
  if (!Object.hasOwn(clients, id)) return;
  const client = clients[id];
  for (const button of document.querySelectorAll('[data-client]')) button.setAttribute('aria-pressed', String(button.dataset.client === id));
  document.querySelector('#client-name').textContent = client.name;
  document.querySelector('#client-instruction').textContent = client.instruction;
  document.querySelector('#config-file').textContent = client.file;
  document.querySelector('#client-command').innerHTML = highlightCode(client.code);
  document.querySelector('.client-config').setAttribute('aria-label', `${client.name} configuration`);
  document.querySelector('#client-next').textContent = client.next;
  document.querySelector('#client-docs').href = client.docs;
  document.querySelector('#client-docs-label').textContent = `Read docs for ${client.name}`;
  try { localStorage.setItem('browspark-client', id); } catch {}
}
for (const button of document.querySelectorAll('[data-client]')) button.addEventListener('click', () => chooseClient(button.dataset.client));
for (const link of document.querySelectorAll('[data-choose-client]')) link.addEventListener('click', () => chooseClient(link.dataset.chooseClient));
let savedClient;
try { savedClient = localStorage.getItem('browspark-client'); } catch {}
chooseClient(Object.hasOwn(clients, savedClient) ? savedClient : 'claude');

const toast = document.querySelector('#copy-status');
let toastTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(code.textContent);
      toast.textContent = 'Copied to clipboard';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      toast.textContent = 'Select and copy the highlighted command.';
      code.closest('pre').focus();
    }
    clearTimeout(toastTimer);
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  });
}
