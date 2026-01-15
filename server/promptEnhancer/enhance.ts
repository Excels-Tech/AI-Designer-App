import crypto from 'crypto';
import { templates } from './templates';

export type ModelFormat = 'sdxl' | 'midjourney' | 'generic';
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3';

export interface EnhanceOptions {
  creativity?: number; // 0..1
  modelFormat?: ModelFormat;
  stylePreset?: string;
  aspectRatio?: AspectRatio;
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0.3;
  return Math.min(1, Math.max(0, n));
}

function normalizePrompt(input: string): string {
  const p = (input ?? '').trim().replace(/\s+/g, ' ');
  return p.length ? p.replace(/[.,;:]+$/g, '') : 'a visually appealing design';
}

function normalizePhrase(input: string): string {
  return (input ?? '')
    .trim()
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/g, '');
}

function seedFromString(s: string): number {
  const hex = crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

function makeRng(seed: number) {
  let x = seed >>> 0;
  return () => {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    // 0..1
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

function weightedPick<T extends { weight: number; phrase: string }>(arr: readonly T[], rand: () => number): string {
  const total = arr.reduce((s, x) => s + (x.weight ?? 1), 0);
  let r = rand() * total;
  for (const item of arr) {
    r -= item.weight ?? 1;
    if (r <= 0) return item.phrase;
  }
  return arr[arr.length - 1]?.phrase ?? '';
}

function computeGroupsToInclude(creativity: number) {
  // 3..7 groups. Order is stable to keep prompts readable.
  const c = clamp01(creativity);
  const count = 3 + Math.round(c * 4);
  const order: (keyof typeof templates.phraseGroups)[] = [
    'style',
    'lighting',
    'camera',
    'composition',
    'detail',
    'colorMood',
    'environment',
  ];
  return order.slice(0, Math.min(order.length, Math.max(3, count)));
}

type StyleBias = 'none' | 'photoreal';

function detectStyleBias(text: string): StyleBias {
  const s = normalizePhrase(text).toLowerCase();
  if (!s) return 'none';
  const asksReal = /\b(photorealistic|photo-realistic|ultra\s+realistic|realistic)\b/.test(s);
  const asksStylized = /\b(anime|manga|cartoon|toon|comic|illustration|vector|sketch|watercolor|oil\s+painting|painterly|3d\s+render|cgi|low\s+poly|pixel\s+art)\b/.test(s);
  if (asksReal && !asksStylized) return 'photoreal';
  return 'none';
}

function filterPhrasesForBias(
  groupKey: keyof typeof templates.phraseGroups,
  phrases: readonly { phrase: string; weight: number }[],
  bias: StyleBias,
  stylePreset: string
) {
  if (bias !== 'photoreal') return phrases;

  if (groupKey === 'style') {
    const banned = new Set(['concept art', 'illustration', '3D render', 'painterly', 'surreal'].map((x) => x.toLowerCase()));
    const filtered = phrases.filter((p) => !banned.has(String(p.phrase ?? '').toLowerCase()));
    return filtered.length ? filtered : phrases;
  }

  // If the preset hints at an on-location/natural environment, avoid forcing a studio backdrop.
  if (groupKey === 'environment') {
    const s = normalizePhrase(stylePreset).toLowerCase();
    if (/\b(on-location|on location|natural environment|environment)\b/.test(s)) {
      const filtered = phrases.filter((p) => String(p.phrase ?? '').toLowerCase() !== 'simple studio backdrop');
      return filtered.length ? filtered : phrases;
    }
  }

  return phrases;
}

function formatAspectRatio(modelFormat: ModelFormat, aspectRatio: AspectRatio) {
  if (modelFormat === 'midjourney') return `--ar ${aspectRatio}`;
  return `aspect ratio ${aspectRatio}`;
}

function uniqueNonEmpty(parts: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = normalizePhrase(p);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function enhancePrompt(prompt: string, options: EnhanceOptions = { }): { enhancedPrompt: string; negativePrompt: string } {
  const base = normalizePrompt(prompt);
  const creativity = clamp01(options.creativity ?? 0.3);
  const modelFormat: ModelFormat = options.modelFormat ?? 'sdxl';
  const aspectRatio: AspectRatio = options.aspectRatio ?? '1:1';
  const stylePreset = normalizePhrase(options.stylePreset ?? '');
  const styleBias = detectStyleBias(`${base} ${stylePreset}`.trim());

  const rand = makeRng(seedFromString(`${base}|${stylePreset}|${modelFormat}|${aspectRatio}|${creativity}`));
  const groups = computeGroupsToInclude(creativity);

  const picked: string[] = [];
  for (const groupKey of groups) {
    const phrases = templates.phraseGroups[groupKey].phrases as any;
    const biased = filterPhrasesForBias(groupKey, phrases, styleBias, stylePreset);
    picked.push(weightedPick(biased as any, rand));
  }

  const parts = uniqueNonEmpty([base, stylePreset, ...picked, formatAspectRatio(modelFormat, aspectRatio)]);
  const enhancedPrompt = parts.join(', ') || 'a visually appealing design, high detail, sharp focus';

  const negativePrompt =
    'blurry, low quality, lowres, watermark, text, logo, jpeg artifacts, deformed, disfigured, bad anatomy, extra limbs, extra fingers, mutated hands, poorly drawn, out of frame';

  return { enhancedPrompt, negativePrompt };
}
