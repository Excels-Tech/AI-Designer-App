import { maybeEnhancePrompt } from '../server/promptEnhancer/runtime';

const variants = [
  'Topband: ONE LOGO ONLY in top-left header; 18–24mm top accent band in brand color; small top-left logo; right-aligned contact row in footer; 12mm safe margins; provide monochrome logo variant.',
  'Corner flourish: ONE LOGO ONLY top-left; bold corner flourish in brand color at top-right; main body uncluttered; minimal centered contact footer; 12mm safe margins; monochrome variant.',
  'Diagonal watermark: ONE LOGO ONLY top-left; subtle diagonal accent at lower-right and very low-opacity watermark in lower quadrant; left-aligned footer contact row; 12mm safe margins; monochrome variant.',
  'Minimal: ONE LOGO ONLY top-left; very wide whitespace, no decorative accents; clear typographic hierarchy; icons-only minimal footer; 12mm safe margins; monochrome variant.',
  'Footer-heavy: ONE LOGO ONLY top-left; minimal header, prominent footer with stacked contact info and separators; ensure 12mm safe margins; monochrome variant.',
];

for (const v of variants) {
  const r = maybeEnhancePrompt('create a professional letterhead with the company logo', { creativity: 0.2, stylePreset: v, aspectRatio: '4:3' }, 'variant-demo');
  console.log('\n---\nVARIANT:\n', v, '\nPROMPT:\n', r.promptForModel, '\nNEG:\n', r.negativePrompt);
}
