import { StyleId, ViewId } from './types.js';
import { commonNegatives, viewSpecs } from './viewSpecs.js';

const styleMap: Record<StyleId, string> = {
  realistic: 'Realistic photography with accurate textures and lighting',
  '3d': 'Clean 3D render with studio lighting',
  lineart: 'High-contrast line art with crisp outlines',
  watercolor: 'Soft watercolor illustration with controlled edges',
};

const studioAnchors = [
  'floating product mockup on invisible stand',
  'neutral studio background',
  'consistent soft studio lighting',
  'single product centered',
];

export function buildBasePrompt(prompt: string, style: StyleId, view: ViewId): string {
  const spec = viewSpecs[view];
  const anchors = spec.anchors ? spec.anchors.join('. ') : '';

  return [
    prompt.trim(),
    `Style: ${styleMap[style]}.`,
    `Viewpoint: ${spec.angle}. ${anchors}`,
    studioAnchors.join('. '),
    'Single image only.',
    commonNegatives.join('. '),
  ].join('\n');
}

export function buildDerivedPrompt(prompt: string, style: StyleId, targetView: ViewId): string {
  const spec = viewSpecs[targetView];
  const anchors = spec.anchors ? spec.anchors.join('. ') : '';

  return [
    'Use the attached image as the exact reference for design, colors, materials, and logos.',
    'Keep the SAME shirt design; only rotate the camera.',
    `Change camera to: ${spec.angle}. ${anchors}`,
    prompt.trim(),
    `Style: ${styleMap[style]}.`,
    studioAnchors.join('. '),
    'Do not invent new designs. Do not change colors. Do not add or remove logos.',
    'Single image only.',
    commonNegatives.join('. '),
  ].join('\n');
}
