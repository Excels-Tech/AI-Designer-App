import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancePrompt } from './enhance';

test('enhancePrompt returns non-empty enhancedPrompt', () => {
  const out = enhancePrompt('a red hoodie on white background', { creativity: 0.3, aspectRatio: '1:1' });
  assert.ok(out.enhancedPrompt.length > 0);
  assert.ok(out.negativePrompt.length > 0);
});

test('enhancePrompt appends at least one descriptor', () => {
  const input = 'simple cat';
  const out = enhancePrompt(input, { creativity: 0.3, aspectRatio: '1:1' });
  assert.notEqual(out.enhancedPrompt.trim(), input.trim());
  assert.ok(out.enhancedPrompt.length > input.trim().length);
});

test('creativity=0 adds fewer phrases than creativity=1', () => {
  const input = 'minimalist product photo of a ceramic mug';
  const low = enhancePrompt(input, { creativity: 0, aspectRatio: '1:1' }).enhancedPrompt;
  const high = enhancePrompt(input, { creativity: 1, aspectRatio: '1:1' }).enhancedPrompt;
  assert.ok(high.length > low.length);
});

