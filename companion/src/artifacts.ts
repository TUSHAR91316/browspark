// Large outputs (traces, profiles, heap snapshots, HAR, reports) are written to disk and referenced by path.
import { mkdirSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const artifactDir = () => process.env.BROWSPARK_ARTIFACTS ?? join(homedir(), '.browspark', 'artifacts');

export interface Artifact { id: string; path: string; bytes: number; kind: string }

export function saveArtifact(kind: string, ext: string, data: string | Buffer, name?: string): Artifact {
  mkdirSync(artifactDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${kind}${name ? '-' + name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) : ''}`;
  const path = join(artifactDir(), `${id}.${ext}`);
  writeFileSync(path, data);
  return { id, path, bytes: statSync(path).size, kind };
}

export function listArtifacts(): Artifact[] {
  try {
    return readdirSync(artifactDir()).sort().reverse().map((f) => ({ id: f.replace(/\.[^.]+$/, ''), path: join(artifactDir(), f), bytes: statSync(join(artifactDir(), f)).size, kind: f.split('-').slice(7, 8)[0] ?? 'file' }));
  } catch { return []; }
}

export function readArtifact(idOrPath: string): string {
  const path = idOrPath.includes('/') ? idOrPath : (listArtifacts().find((a) => a.id === idOrPath)?.path ?? join(artifactDir(), idOrPath));
  return readFileSync(path, 'utf8');
}
