import test from 'node:test';
import assert from 'node:assert/strict';
import { stripKeysDeep } from './stripKeysDeep';

test('stripKeysDeep removes keys at any depth', () => {
  const input = {
    ok: true,
    enhancedPrompt: 'LEAK',
    nested: {
      a: 1,
      negativePrompt: 'LEAK',
      deeper: [{ enhancedPrompt: 'LEAK' }, { keep: 'x' }],
    },
  };

  const out = stripKeysDeep(input, ['enhancedPrompt', 'negativePrompt']);
  const json = JSON.stringify(out);

  assert.ok(!json.includes('enhancedPrompt'));
  assert.ok(!json.includes('negativePrompt'));
  assert.equal((out as any).ok, true);
  assert.equal((out as any).nested.a, 1);
  assert.equal((out as any).nested.deeper[1].keep, 'x');
});

