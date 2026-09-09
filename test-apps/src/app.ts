// Source for the debug test page. Built to ../dist/app.js with a source map by the test harness.
export class LeakItem { data: number[]; constructor(i: number) { this.data = new Array(64).fill(i); } }
const leaked: LeakItem[] = ((window as any).leaked = []);

export function slowFunction(iterations: number): number {
  let acc = 0;
  const start = performance.now();
  while (performance.now() - start < iterations) { acc += Math.sqrt(acc + 1); }
  return acc;
}

export function explode(reason: string): never {
  throw new Error('Boom: ' + reason);
}

async function callApi(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const text = await res.text();
  const out = document.getElementById('out')!;
  out.textContent = `${res.status} ${text}`;
  return res;
}

document.getElementById('log')!.addEventListener('click', () => {
  console.log('hello from app', { user: 'ada', tags: ['x', 'y'], nested: { deep: true } });
  console.warn('careful');
});
document.getElementById('error')!.addEventListener('click', () => { explode('button'); });
document.getElementById('fetch-ok')!.addEventListener('click', () => { void callApi('/api/items'); });
document.getElementById('fetch-404')!.addEventListener('click', () => { void callApi('/api/missing'); });
document.getElementById('fetch-post')!.addEventListener('click', () => { void callApi('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'hi' }) }); });
document.getElementById('slow')!.addEventListener('click', () => { const r = slowFunction(300); document.getElementById('out')!.textContent = 'slow done ' + Math.round(r); });
document.getElementById('leak')!.addEventListener('click', () => { for (let i = 0; i < 20000; i++) leaked.push(new LeakItem(i)); document.getElementById('out')!.textContent = 'leaked ' + leaked.length; });
document.getElementById('sw')!.addEventListener('click', async () => { const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; document.getElementById('out')!.textContent = 'sw registered ' + reg.scope; });
document.getElementById('storage')!.addEventListener('click', async () => {
  localStorage.setItem('theme', 'dark'); sessionStorage.setItem('visit', '1'); document.cookie = 'session=abc123; path=/';
  await new Promise<void>((res, rej) => { const q = indexedDB.open('appdb', 1); q.onupgradeneeded = () => q.result.createObjectStore('todos', { keyPath: 'id' }); q.onsuccess = () => { const tx = q.result.transaction('todos', 'readwrite'); tx.objectStore('todos').put({ id: 1, title: 'write tests' }); tx.oncomplete = () => { q.result.close(); res(); }; }; q.onerror = () => rej(q.error); });
  const c = await caches.open('v1'); await c.put('/cached.txt', new Response('cached body'));
  document.getElementById('out')!.textContent = 'storage written';
});
document.getElementById('ws')!.addEventListener('click', () => {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send('ping');
  ws.onmessage = (m) => { document.getElementById('out')!.textContent = 'ws ' + m.data; ws.close(); };
});
document.getElementById('shift')!.addEventListener('click', () => { const b = document.createElement('div'); b.style.height = '200px'; b.textContent = 'inserted'; document.body.insertBefore(b, document.body.firstChild); });
console.info('app ready');
