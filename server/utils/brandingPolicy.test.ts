import test from 'node:test';
import assert from 'node:assert/strict';
import { allowBranding, NO_BRANDING_BLOCK_POSITIVE } from './brandingPolicy';
import { maybeEnhancePrompt } from '../promptEnhancer/runtime';

test('allowBranding respects explicit "no logo/no text/no branding"', () => {
  assert.equal(allowBranding('red t-shirt mockup, clean studio lighting, no brand name no logo no text'), false);
  assert.equal(allowBranding('letterhead template, minimal, no branding'), false);
});

test('allowBranding turns on only for explicit add/include logo/text requests', () => {
  assert.equal(allowBranding('make a logo for Jerrax'), true);
  assert.equal(allowBranding('t-shirt with logo on chest'), true);
  assert.equal(allowBranding('add my company name on the shirt'), true);
});

test('prompt enhancer appends strict no-branding block by default', (t) => {
  t.mock.method(console, 'log', () => {});
  const prev = process.env.PROMPT_ENHANCER_ENABLED;
  process.env.PROMPT_ENHANCER_ENABLED = 'true';
  const p = 'High quality apparel/garment product mockup. One product only, centered, clean background. User request: red t-shirt mockup, no logo no text';
  const out = maybeEnhancePrompt(p, { creativity: 0.3, aspectRatio: '1:1' }, 'test');
  assert.ok(out.promptForModel.includes(NO_BRANDING_BLOCK_POSITIVE), `promptForModel=${out.promptForModel}`);
  if (typeof prev === 'string') process.env.PROMPT_ENHANCER_ENABLED = prev;
  else delete process.env.PROMPT_ENHANCER_ENABLED;
});
