import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateViewsResponse } from './generateViewsResponse';

test('buildGenerateViewsResponse does not leak enhanced prompt fields', () => {
  const buf = Buffer.from('png', 'utf8');
  const response = buildGenerateViewsResponse({
    composite: {
      dataUrl: 'data:image/png;base64,cG5n',
      buffer: buf,
      dimensions: { width: 512, height: 512 },
    },
    tiles: [
      { view: 'front', dataUrl: 'data:image/png;base64,cG5n', buffer: buf },
      { view: 'back', dataUrl: 'data:image/png;base64,cG5n', buffer: buf },
    ],
    grid: { columns: 2, rows: 1 },
    tileWidth: 256,
    tileHeight: 256,
    viewOrder: ['front', 'back'],
    designId: 'abc123',
  });

  const json = JSON.stringify(response);
  assert.ok(!json.includes('enhancedPrompt'));
  assert.ok(!json.includes('negativePrompt'));
});

