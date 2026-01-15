import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveModelFormatFromEnv,
  isApparelOrFashionPrompt,
  isFashionModelPrompt,
  isGarmentMockupPrompt,
  isPromptEnhancerDebug,
  isPromptEnhancerEnabled,
  maybeEnhancePrompt,
  readPromptEnhancerEnv,
  buildMaleModelViewConstraints,
  buildTryOnModelViewConstraints,
} from './runtime';

test('feature flags default safely', () => {
  const defaults = readPromptEnhancerEnv({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.debug, false);

  assert.equal(readPromptEnhancerEnv({ PROMPT_ENHANCER_ENABLED: 'false' }).enabled, false);
  assert.equal(readPromptEnhancerEnv({ PROMPT_ENHANCER_DEBUG: 'true' }).debug, true);

  assert.equal(readPromptEnhancerEnv({ PROMPT_ENHANCER_MODEL_FORMAT: 'unknown' }).modelFormatRaw, 'unknown');
  assert.equal(readPromptEnhancerEnv({ PROMPT_ENHANCER_MODEL_FORMAT: 'midjourney' }).modelFormatRaw, 'midjourney');
  assert.equal(readPromptEnhancerEnv({ PROMPT_ENHANCER_MODEL_FORMAT: 'generic' }).modelFormatRaw, 'generic');

  // Live helpers should still be callable (no throw); behavior depends on process.env at runtime.
  assert.equal(typeof isPromptEnhancerEnabled(), 'boolean');
  assert.equal(typeof isPromptEnhancerDebug(), 'boolean');
  assert.ok(['sdxl', 'midjourney', 'generic'].includes(deriveModelFormatFromEnv()));
});

test('isApparelOrFashionPrompt detects apparel/fashion intents', () => {
  assert.equal(isApparelOrFashionPrompt('a man wearing a hoodie'), true);
  assert.equal(isApparelOrFashionPrompt('t-shirt mockup for my logo'), true);
  assert.equal(isApparelOrFashionPrompt('cat in a basket'), false);

  // Prefer the "User request:" segment when present (matches UI templating).
  assert.equal(
    isApparelOrFashionPrompt('No clothing. No t-shirt. User request: cat in a basket'),
    false
  );
  assert.equal(
    isApparelOrFashionPrompt('No clothing. No t-shirt. User request: a man wearing a hoodie'),
    true
  );
});

test('mockup vs fashion detectors', () => {
  assert.equal(isGarmentMockupPrompt('t-shirt mockup for my logo'), true);
  assert.equal(isGarmentMockupPrompt('hoodie flat lay mockup'), true);
  assert.equal(isFashionModelPrompt('a man wearing a hoodie'), true);
  assert.equal(isFashionModelPrompt('fashion model in a red dress'), true);
  assert.equal(isApparelOrFashionPrompt('men wear soccer uniform'), true);
  assert.equal(isFashionModelPrompt('men wear soccer uniform'), true);
});

test('maybeEnhancePrompt strips apparel-blocking lines only for apparel prompts', (t) => {
  // NOTE: This test avoids mutating process.env/console to remain parallel-safe under node --test.
  t.mock.method(console, 'log', () => {});

    const apparelTemplatedPrompt =
      'Generate exactly what the user requests. No clothing. No t-shirt. No hoodie. No suit. No apparel mockup. No mockups. ' +
      'User request: a man wearing a hoodie.';
    const apparelOut = maybeEnhancePrompt(apparelTemplatedPrompt, { creativity: 0.3, aspectRatio: '1:1' }, 'test');
    assert.ok(!/no\s+hoodie/i.test(apparelOut.promptForModel));
    assert.ok(!/no\s+t-?\s*shirt/i.test(apparelOut.promptForModel));
    assert.ok(!/no\s+mockups?/i.test(apparelOut.promptForModel));
    assert.ok(/fashion photo/i.test(apparelOut.promptForModel));
    assert.ok(!/one garment only/i.test(apparelOut.promptForModel));

    const nonApparelTemplatedPrompt =
      'Generate exactly what the user requests. No clothing. No t-shirt. No hoodie. No suit. No apparel mockup. No mockups. ' +
      'User request: cat in a basket.';
    const nonApparelOut = maybeEnhancePrompt(nonApparelTemplatedPrompt, { creativity: 0.3, aspectRatio: '1:1' }, 'test');
    assert.ok(!/no\s+clothing/i.test(nonApparelOut.promptForModel));
});

test('mode selection: mockup prompt keeps mockup framing', (t) => {
  // NOTE: This test avoids mutating process.env/console to remain parallel-safe under node --test.
  t.mock.method(console, 'log', () => {});

  const p =
    'Generate exactly what the user requests. ' +
    'User request: soccer jersey mockup.';
  const out = maybeEnhancePrompt(p, { creativity: 0.3, aspectRatio: '1:1' }, 'test');
  assert.ok(/apparel mockup\/product photo/i.test(out.promptForModel));
});

test('buildTryOnModelViewConstraints includes face constraints for front', () => {
  const s = buildTryOnModelViewConstraints('front');
  assert.ok(/exact same garment/i.test(s));
  assert.ok(/do not substitute/i.test(s));
  assert.ok(/show a clear human face/i.test(s));
  assert.ok(/no faceless/i.test(s));
  assert.ok(/same outfit in every view/i.test(s));
});

test('buildTryOnModelViewConstraints includes bottoms constraints for back', () => {
  const s = buildTryOnModelViewConstraints('back');
  assert.ok(/exact same garment/i.test(s));
  assert.ok(/do not substitute/i.test(s));
  assert.ok(/missing bottoms/i.test(s));
  assert.ok(/same outfit in every view/i.test(s));
});

test('men wear soccer uniform routes to fashion mode and no mockup preface', (t) => {
  t.mock.method(console, 'log', () => {});

  const p =
    'High quality apparel/garment design mockup. One garment only, centered, clean background. Keep the garment fully visible. ' +
    'User request: men wear soccer uniform in orange colour';
  const out = maybeEnhancePrompt(p, { creativity: 0.4, aspectRatio: '1:1' }, 'test');
  assert.ok(isApparelOrFashionPrompt('men wear soccer uniform in orange colour'));
  assert.ok(isFashionModelPrompt('men wear soccer uniform in orange colour'));
  assert.ok(!/one garment only/i.test(out.promptForModel));
  assert.ok(!/high quality apparel\/garment design mockup/i.test(out.promptForModel));
  assert.ok(/fashion photo as requested/i.test(out.promptForModel));
});

test('cat prompt does not include apparel prefaces', (t) => {
  t.mock.method(console, 'log', () => {});
  const out = maybeEnhancePrompt('cat in basket', { creativity: 0.4, aspectRatio: '1:1' }, 'test');
  assert.ok(!/apparel mockup\/product photo as requested/i.test(out.promptForModel));
  assert.ok(!/fashion photo as requested/i.test(out.promptForModel));
});

test('mode=none outputs clean GPT-style photoreal paragraph + Negative prompt line', (t) => {
  t.mock.method(console, 'log', () => {});
  const out = maybeEnhancePrompt('create a cat', { creativity: 0.3, aspectRatio: '1:1' }, 'test');
  assert.ok(/^photorealistic,/i.test(out.promptForModel));
  assert.ok(/\ba cat\b/i.test(out.promptForModel));
  assert.ok(!/\bcreate a cat\b/i.test(out.promptForModel));
  assert.ok(!/\. \./i.test(out.promptForModel));
  assert.ok(!/avoid brand names/i.test(out.promptForModel));
  assert.ok(!/style intent:/i.test(out.promptForModel));
  assert.ok(!/requestid/i.test(out.promptForModel));
  assert.ok(/fur|whiskers|eyes/i.test(out.promptForModel));
  assert.ok(/subtle painterly realism on close inspection/i.test(out.promptForModel));
  assert.ok(/\nnegative prompt:/i.test(out.promptForModel));
  assert.ok(/aspect ratio 1:1/i.test(out.promptForModel));
});

test('human prompt "create a women" normalizes to one woman and blocks footwear/product fallback', (t) => {
  t.mock.method(console, 'log', () => {});
  const out = maybeEnhancePrompt('create a women', { creativity: 0.4, aspectRatio: '1:1' }, 'test');
  assert.ok(/\ba woman\b/i.test(out.promptForModel));
  assert.ok(!/\bcreate a women\b/i.test(out.promptForModel));
  assert.ok(/skin|face|eyes/i.test(out.promptForModel));
  assert.ok(!/fine grain|micro-scratches/i.test(out.promptForModel));
  assert.ok(!/avoid brand names/i.test(out.promptForModel));
  assert.ok(/\nnegative prompt:/i.test(out.promptForModel));
  assert.ok(/shoes|boots|footwear/i.test(out.promptForModel));
});

test('plural human prompt keeps plural when group intent present', (t) => {
  t.mock.method(console, 'log', () => {});
  const out = maybeEnhancePrompt('women in a group', { creativity: 0.4, aspectRatio: '1:1' }, 'test');
  assert.ok(/\bwomen\b/i.test(out.promptForModel));
  assert.ok(!/\ba woman\b/i.test(out.promptForModel));
  assert.ok(/skin|face|eyes/i.test(out.promptForModel));
  assert.ok(/\nnegative prompt:/i.test(out.promptForModel));
});

test('painterly realism phrasing still allows photoreal forcing when user asks for real-life look', (t) => {
  t.mock.method(console, 'log', () => {});
  const prompt =
    'A scene painted by a master oil painter, yet indistinguishable from real life, photorealistic, natural brush strokes.';
  const out = maybeEnhancePrompt(prompt, { creativity: 0.2, aspectRatio: '1:1' }, 'test');
  assert.ok(/photorealistic/i.test(out.promptForModel));
  assert.ok(/subtle painterly realism on close inspection/i.test(out.promptForModel));
});

test('anime prompt keeps stylized intent (no forced Photorealistic) and appends minimal Negative prompt', (t) => {
  t.mock.method(console, 'log', () => {});
  const out = maybeEnhancePrompt('anime woman portrait', { creativity: 0.7, aspectRatio: '1:1' }, 'test');
  assert.ok(!/^photorealistic,/i.test(out.promptForModel));
  assert.ok(/anime/i.test(out.promptForModel));
  assert.ok(/\nnegative prompt:/i.test(out.promptForModel));
  assert.ok(/watermark|text|logo/i.test(out.promptForModel));
});
