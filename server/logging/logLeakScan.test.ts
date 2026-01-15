import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.js'))) out.push(full);
  }
  return out;
}

test('no logs print enhancedPrompt/negativePrompt outside debug-only runtime', () => {
  const serverRoot = path.resolve(process.cwd(), 'server');
  const files = listFiles(serverRoot);

  const offenders: string[] = [];
  const keys = ['enhancedPrompt', 'negativePrompt'];

  for (const file of files) {
    const rel = path.relative(serverRoot, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');

    const logCallRegex = /console\.(log|info|warn|error)\s*\(/g;
    let match: RegExpExecArray | null = null;
    let hasLeakyLog = false;

    while ((match = logCallRegex.exec(content))) {
      // Check within a bounded window after the log call starts (covers typical multi-line logs).
      const snippet = content.slice(match.index, match.index + 1200);
      if (keys.some((k) => snippet.includes(k))) {
        hasLeakyLog = true;
        break;
      }
    }

    if (!hasLeakyLog) continue;

    // Allow only the debug-only log inside promptEnhancer/runtime.ts
    if (rel === 'promptEnhancer/runtime.ts') continue;

    offenders.push(rel);
  }

  assert.deepEqual(offenders, []);
});
