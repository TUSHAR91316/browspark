// Minimal source-map v3 decoder: enough to map generated<->original lines for breakpoints and stack traces.
export interface Mapping { genLine: number; genCol: number; src: number; origLine: number; origCol: number; name?: number }
export interface SourceMap { sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: Mapping[]; sourceRoot?: string; file?: string }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function* vlq(s: string): Generator<number> {
  let value = 0, shift = 0;
  for (const ch of s) {
    const d = B64.indexOf(ch); if (d < 0) throw new Error('bad VLQ');
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    yield value & 1 ? -(value >> 1) : value >> 1;
    value = 0; shift = 0;
  }
}

export function parseSourceMap(json: string): SourceMap {
  const raw = JSON.parse(json);
  if (raw.sections) throw new Error('indexed source maps (sections) are not supported');
  const mappings: Mapping[] = [];
  let src = 0, origLine = 0, origCol = 0, name = 0;
  raw.mappings.split(';').forEach((line: string, genLine: number) => {
    let genCol = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const f = [...vlq(seg)];
      genCol += f[0];
      if (f.length >= 4) { src += f[1]; origLine += f[2]; origCol += f[3]; if (f.length >= 5) name += f[4]; mappings.push({ genLine, genCol, src, origLine, origCol, name: f.length >= 5 ? name : undefined }); }
    }
  });
  return { sources: (raw.sources ?? []).map((s: string) => (raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') + s : s)), sourcesContent: raw.sourcesContent, names: raw.names ?? [], mappings, sourceRoot: raw.sourceRoot, file: raw.file };
}

/** Generated (0-based line/col) -> original. Picks the closest mapping at or before the column on that line. */
export function toOriginal(map: SourceMap, line: number, col: number) {
  let best: Mapping | undefined;
  for (const m of map.mappings) { if (m.genLine !== line) continue; if (m.genCol <= col && (!best || m.genCol > best.genCol)) best = m; }
  if (!best) return undefined;
  return { source: map.sources[best.src], line: best.origLine, column: best.origCol, name: best.name !== undefined ? map.names[best.name] : undefined };
}

/** Original (0-based line) -> generated position(s). Returns the first mapping on that original line (lowest column). */
export function toGenerated(map: SourceMap, source: string, line: number, col?: number) {
  const idx = map.sources.findIndex((s) => s === source || s.endsWith('/' + source) || source.endsWith('/' + s) || s.endsWith(source));
  if (idx < 0) return undefined;
  let best: Mapping | undefined;
  for (const m of map.mappings) {
    if (m.src !== idx || m.origLine !== line) continue;
    if (col !== undefined ? Math.abs(m.origCol - col) < Math.abs((best?.origCol ?? Infinity) - col) : !best || m.origCol < best.origCol) best = m;
  }
  return best && { line: best.genLine, column: best.genCol, sourceIndex: idx };
}

export function resolveMapUrl(scriptUrl: string, sourceMapURL: string): string {
  if (/^data:/.test(sourceMapURL)) return sourceMapURL;
  try { return new URL(sourceMapURL, scriptUrl).href; } catch { return sourceMapURL; }
}
export function decodeDataUrl(u: string): string {
  const i = u.indexOf(',');
  const meta = u.slice(0, i), data = u.slice(i + 1);
  return /;base64/.test(meta) ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
}
