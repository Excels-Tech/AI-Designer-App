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

test('routes do not call res.json(...) directly (use safeJson / sanitizer)', () => {
  const serverRoot = path.resolve(process.cwd(), 'server');
  const files = listFiles(serverRoot);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(serverRoot, file).replace(/\\/g, '/');
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    if (rel === 'utils/safeJson.ts') continue;

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);

    // Policy: server handlers should not call `res.*.json(...)` (including chained `res.status(...).json(...)`).
    // Allowed: `safeJson(...)` or `res.json(stripKeysDeep(...))`.
    const bad = lines.some((line) => {
      if (!line.includes('.json(')) return false;
      if (!line.includes('res.') && !line.includes('return res')) return false;
      if (line.includes('safeJson(')) return false;
      if (line.includes('stripKeysDeep(')) return false;
      return true;
    });

    if (bad) offenders.push(rel);
  }

  assert.deepEqual(offenders, []);
});
