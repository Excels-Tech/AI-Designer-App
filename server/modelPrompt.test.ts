import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMannequinConversionPrompt, modelFrontPrompt, modelBackPrompt } from './index';

test('convert-model prompt allows boy/girl and enforces real DSLR photo, no CGI', () => {
  const prompt = buildMannequinConversionPrompt('boy');
  assert.match(prompt, /REAL DSLR PHOTO/i);
  assert.match(prompt, /real boy \(male child, age ~8–12\)/i);
  assert.match(prompt, /NOT girl, NOT female/i);
  assert.match(prompt, /NO CGI/i);
});

test('model front/back prompts use flat catalog lighting and real human realism cues', () => {
  const front = modelFrontPrompt('female', undefined, 'lightgray');
  const back = modelBackPrompt('female', undefined, 'white');
  [front, back].forEach((p) => {
    assert.match(p, /Flat, even catalog lighting/i);
    assert.match(p, /REAL DSLR PHOTO/i);
    assert.match(p, /NO CGI/i);
  });
});
