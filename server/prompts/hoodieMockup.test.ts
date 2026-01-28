import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHoodieMockupPrompt } from './hoodieMockup';

test('hoodie prompt for white product on light gray background enforces pure white and no shadows', () => {
  const prompt = buildHoodieMockupPrompt({
    basePrompt: 'plain hoodie product mockup',
    hoodieColor: 'white',
    bgColor: 'lightgray',
  });

  assert.match(prompt, /pure white/i);
  assert.match(prompt, /LIGHT GRAY background \(#DADADA\)/i);
  assert.match(prompt, /ZERO shadows/i);
  assert.match(prompt, /do not tint the garment gray/i);
  assert.match(prompt, /Do NOT apply left-to-right or top-to-bottom brightness gradients on the garment/i);
});
