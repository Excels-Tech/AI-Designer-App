import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveDesignPayload } from './saveDesignPayload';

test('buildSaveDesignPayload stores only original prompt and does not allow enhancer leakage', () => {
  const payload = buildSaveDesignPayload({
    title: 'x',
    userId: 'u',
    prompt: 'raw user prompt',
    style: 'realistic',
    resolution: 1024,
    views: ['front', 'back'],
    composite: 'data:image/png;base64,cG5n',
    images: [{ view: 'front', src: 'data:image/png;base64,cG5n' }],
  }) as any;

  payload.enhancedPrompt = 'LEAK';
  payload.negativePrompt = 'LEAK';

  const json = JSON.stringify(payload);
  assert.ok(json.includes('enhancedPrompt')); // test setup sanity

  const clean = buildSaveDesignPayload({
    title: 'x',
    userId: 'u',
    prompt: 'raw user prompt',
    style: 'realistic',
    resolution: 1024,
    views: ['front', 'back'],
    composite: 'data:image/png;base64,cG5n',
    images: [{ view: 'front', src: 'data:image/png;base64,cG5n' }],
  }) as any;

  const cleanJson = JSON.stringify(clean);
  assert.ok(!cleanJson.includes('enhancedPrompt'));
  assert.ok(!cleanJson.includes('negativePrompt'));
  assert.equal(clean.prompt, 'raw user prompt');
});

