import crypto from 'crypto';
import { enhancePrompt, type AspectRatio, type EnhanceOptions, type ModelFormat } from './enhance';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const APPAREL_OR_FASHION_KEYWORDS = [
  'hoodie',
  't-shirt',
  'tshirt',
  'shirt',
  'tee',
  'jacket',
  'coat',
  'dress',
  'pants',
  'jeans',
  'shorts',
  'socks',
  'skirt',
  'saree',
  'abaya',
  'hijab',
  'scarf',
  'cap',
  'hat',
  'shoes',
  'sneakers',
  'heels',
  'boots',
  'uniform',
  'soccer uniform',
  'football uniform',
  'sports uniform',
  'jersey',
  'football jersey',
  'soccer jersey',
  'kit',
  'soccer kit',
  'football kit',
  'soccer shorts',
  'football shorts',
  'shin guards',
  'shin-guards',
  'fashion',
  'model',
  'runway',
  'outfit',
  'lookbook',
  'streetwear',
  'clothing',
  'apparel',
  'wear',
  'wearing',
  'mockup',
  'print',
  'printing',
  'dtg',
  'embroidery',
  'screenprint',
  'label',
  'tag',
] as const;

function keywordPattern(keyword: string): RegExp {
  const raw = String(keyword ?? '').trim();
  const inner = escapeRegExp(raw)
    .replace(/\\\s+/g, '\\s+')
    // Treat hyphens/spaces as equivalent for compound terms (e.g. "shin-guards" vs "shin guards").
    .replace(/\\-/g, '[-\\s]+');
  return new RegExp(`\\b${inner}\\b`, 'i');
}

const APPAREL_OR_FASHION_PATTERNS = APPAREL_OR_FASHION_KEYWORDS.map(keywordPattern);

const GARMENT_MOCKUP_KEYWORDS = [
  'mockup',
  'mock up',
  'tshirt mockup',
  't-shirt mockup',
  'tee mockup',
  'print',
  'printing',
  'dtg',
  'screenprint',
  'screen print',
  'embroidery',
  'logo on',
  'design on',
  'front print',
  'back print',
  'chest logo',
  'label',
  'tag',
  'hang tag',
  'neck label',
  'care label',
  'product photo',
  'flat lay',
  'folded',
  'on hanger',
] as const;

const FASHION_MODEL_KEYWORDS_STRONG = [
  'wear',
  'wearing',
  'man wearing',
  'woman wearing',
  'person wearing',
  'men wear',
  'man wear',
  'woman wear',
  'fashion model',
  'runway',
  'streetwear',
  'outfit',
  'lookbook',
  'editorial',
  'portrait',
  'full body',
  'pose',
] as const;

const FASHION_MODEL_CONTEXT_KEYWORDS = [
  'fashion',
  'wear',
  'wearing',
  'runway',
  'outfit',
  'lookbook',
  'streetwear',
  'hoodie',
  'dress',
  'shirt',
  't-shirt',
  'tshirt',
  'jacket',
  'coat',
  'pants',
  'jeans',
  'shorts',
  'skirt',
  'saree',
  'abaya',
  'hijab',
  'scarf',
  'uniform',
  'jersey',
  'kit',
] as const;

const GARMENT_MOCKUP_PATTERNS = GARMENT_MOCKUP_KEYWORDS.map(keywordPattern);
const FASHION_MODEL_STRONG_PATTERNS = FASHION_MODEL_KEYWORDS_STRONG.map(keywordPattern);
const FASHION_MODEL_CONTEXT_PATTERNS = FASHION_MODEL_CONTEXT_KEYWORDS.map(keywordPattern);
const GENERIC_MODEL_PATTERN = keywordPattern('model');

function extractUserRequestSegment(p: string): string {
  const s = String(p ?? '');
  const markers = [/user request\s*:/i, /user prompt\s*:/i];
  let bestIdx = -1;
  let bestMarkerLen = 0;
  for (const re of markers) {
    const m = re.exec(s);
    if (!m || typeof m.index !== 'number') continue;
    if (m.index >= bestIdx) {
      bestIdx = m.index;
      bestMarkerLen = m[0].length;
    }
  }
  if (bestIdx === -1) return s;
  return s.slice(bestIdx + bestMarkerLen).trim();
}

export function isApparelOrFashionPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return APPAREL_OR_FASHION_PATTERNS.some((re) => re.test(s));
}

export function detectFirstApparelKeyword(p: string): string | null {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return null;
  // Find the first keyword in the configured list that matches.
  for (const k of APPAREL_OR_FASHION_KEYWORDS) {
    const re = keywordPattern(k);
    if (re.test(s)) return k;
  }
  return null;
}

export function isGarmentMockupPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return GARMENT_MOCKUP_PATTERNS.some((re) => re.test(s));
}

export function isFashionModelPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  if (FASHION_MODEL_STRONG_PATTERNS.some((re) => re.test(s))) return true;

  // Avoid overly broad triggers (e.g. "3D model of a chair"): require context beyond just "model".
  if (GENERIC_MODEL_PATTERN.test(s) && FASHION_MODEL_CONTEXT_PATTERNS.some((re) => re.test(s))) return true;

  // Uniform/kit/jersey prompts: require a person/wear context.
  const hasUniform = /\b(uniform|jersey|kit)\b/i.test(s);
  const hasPersonContext = /\b(man|men|woman|person|player|athlete|model)\b/i.test(s);
  const hasWear = /\b(wear|wearing)\b/i.test(s);
  if (hasUniform && (hasWear || hasPersonContext)) return true;

  return false;
}

function stripApparelBlockingLinesFromPrompt(p: string): string {
  const patterns: RegExp[] = [
    /(^|[\s.])no\s+clothing\s*\.?/gi,
    /(^|[\s.])no\s+t-?\s*shirt\s*\.?/gi,
    /(^|[\s.])no\s+tshirt\s*\.?/gi,
    /(^|[\s.])no\s+hoodie\s*\.?/gi,
    /(^|[\s.])no\s+suit\s*\.?/gi,
    /(^|[\s.])no\s+apparel\s+mockup\s*\.?/gi,
    /(^|[\s.])no\s+mockups?\s*\.?/gi,
  ];

  let out = String(p ?? '');
  for (const re of patterns) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

function stripKnownApparelPrefacesFromPrompt(p: string): string {
  const patterns: RegExp[] = [
    /(^|[\s.])high[-\s]*quality\s+apparel\/garment\s+design\s+mock\s*up\s*\.?/gi,
    /(^|[\s.])high[-\s]*quality\s+apparel\/garment\s+design\s+mockup\s*\.?/gi,
    /(^|[\s.])one\s+garment\s+only\b[^.]*\.?/gi,
    /(^|[\s.])centered\b[^.]*clean\s+background\b[^.]*\.?/gi,
    /(^|[\s.])keep the garment fully visible\s*\.?/gi,
    /(^|[\s.])apparel mockup\/product photo as requested\s*\.?/gi,
    /(^|[\s.])ensure the print\/placement is clearly visible and readable\s*\.?/gi,
    /(^|[\s.])keep it as a single garment\/product presentation; lighting and styling may vary\s*\.?/gi,
    /(^|[\s.])fashion photo as requested\s*\.?/gi,
    /(^|[\s.])one person\/model wearing the garment; encourage natural pose, movement, and expression\s*\.?/gi,
    /(^|[\s.])high quality fashion photo\s*\.?/gi,
    /(^|[\s.])high quality apparel image\s*\.?/gi,
    /(^|[\s.])focus on the garment and its material\/fit\s*\.?/gi,
    /(^|[\s.])choose a clean composition that matches the user request\s*\.?/gi,
  ];

  let out = String(p ?? '');
  for (const re of patterns) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

type ApparelMode = 'mockup' | 'fashion' | 'neutral' | 'none';

type StyleTier = 'realistic' | 'cinematic' | 'artistic';

function styleTierFromCreativity(creativity: number): StyleTier {
  const c = Number.isFinite(Number(creativity)) ? Number(creativity) : 0.3;
  if (c < 0.3) return 'realistic';
  if (c <= 0.6) return 'cinematic';
  return 'artistic';
}

function styleTierLine(tier: StyleTier): string {
  if (tier === 'realistic') return 'Style intent: grounded, accurate realism with minimal stylization.';
  if (tier === 'cinematic')
    return 'Style intent: cinematic composition with expressive lighting, environmental context, and subtle storytelling.';
  return 'Style intent: artistic and imaginative; emphasize emotion, motion, and dramatic environments while staying true to the subject.';
}

const SOFT_GUIDANCE_LINE = 'Avoid adding elements that were not explicitly requested by the user.';
const FLEXIBLE_COMPOSITION_LINE = 'Choose a background and composition that best enhances the subject.';
const CREATIVE_VARIATION_LINE = 'Introduce subtle creative variations in mood, lighting, or perspective.';
const BRAND_SAFETY_ONE_LINER =
  'Avoid brand names, trademarked logos, and signature brand patterns unless explicitly requested.';

const NON_APPAREL_ENVIRONMENT_LINE = 'Choose a natural or cinematic environment that enhances the subject.';
const NON_APPAREL_VARIATION_LINE =
  'Introduce creative variations in environment, pose, expression, lighting, or perspective while staying true to the subject.';
const ANIMAL_PERSONALITY_LINE =
  'Convey personality, emotion, and natural movement appropriate to the animal.';
const NON_PRODUCT_PHOTOREAL_LINE =
  'Render as a fully photorealistic, real-world image with realistic materials/textures and natural lighting (unless the user requested a stylized look).';
const NON_PRODUCT_PHOTOREAL_STYLE_PRESET =
  'photorealistic, ultra realistic, realistic textures, natural lighting, on-location environment';
const NON_PRODUCT_NEGATIVE_BASE = [
  'cartoon',
  'anime',
  'illustration',
  'CGI',
  '3D render',
  'plastic texture',
  'fake lighting',
  'oversharpened',
  'AI artifacts',
  'unrealistic proportions',
  'extra limbs',
  'distorted anatomy',
  'watermark',
  'text',
  'logo',
] as const;

const HUMAN_FALLBACK_NEGATIVES = [
  'shoes',
  'boots',
  'footwear',
  'fashion product',
  'catalog shot',
  'product shot',
  'product photo',
  'mannequin',
  'studio cutout',
] as const;

function buildNegativePromptLine(opts: { kind: 'human' | 'animal' | 'generic'; minimal?: boolean }): string {
  const extra = opts.kind === 'human' ? Array.from(HUMAN_FALLBACK_NEGATIVES) : [];
  const base = opts.minimal ? ['watermark', 'text', 'logo', 'distorted anatomy', 'extra limbs'] : Array.from(NON_PRODUCT_NEGATIVE_BASE);
  return `Negative prompt: ${[...extra, ...base].join(', ')}`;
}

function mergeStylePreset(existing: string | undefined, extra: string): string {
  const a = String(extra ?? '').trim();
  const b = String(existing ?? '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}, ${b}`;
}

function userRequestedNonPhotorealStyle(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;

  const hasPhotorealSignal =
    /\b(photorealistic|photo-realistic|ultra\s+realistic|realistic|looks\s+real|real\s+life|indistinguishable\s+from\s+real\s+life|true-?to-?life|real-?world)\b/i.test(
      s
    );

  const hasStrongStylizedSignal = [
    'anime',
    'manga',
    'cartoon',
    'toon',
    'comic',
    'illustration',
    'vector',
    'svg',
    'line art',
    'sketch',
    '3d render',
    'cgi',
    'low poly',
    'pixel art',
  ].some((w) => keywordPattern(w).test(s));

  // "Painterly realism" can still be photoreal if the user explicitly asks for real-life realism.
  const hasPainterlySignal = ['painterly', 'oil painting', 'watercolor', 'brush strokes', 'painted'].some((w) =>
    keywordPattern(w).test(s)
  );

  if (hasStrongStylizedSignal) return true;
  if (hasPainterlySignal && !hasPhotorealSignal) return true;
  return false;
}

function isHumanPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return /\b(woman|women|man|men|person|people|human|girl|boy|lady|gentleman|female|male)\b/i.test(s);
}

function hasMultiplePeopleIntent(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return /\b(two|three|four|five|group|crowd|multiple|many|several|pair|couple)\b/i.test(s);
}

function isGraphicOrDesignPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return [
    'logo',
    'icon',
    'branding',
    'brand identity',
    'typography',
    'poster',
    'flyer',
    'banner',
    'thumbnail',
    'cover',
    'sticker',
    'clipart',
    'seamless pattern',
    'pattern',
  ].some((w) => keywordPattern(w).test(s));
}

function shouldForcePhotorealNonProduct(p: string, apparelMode: ApparelMode): boolean {
  if (apparelMode !== 'none') return false;
  if (userRequestedNonPhotorealStyle(p)) return false;
  if (isGraphicOrDesignPrompt(p)) return false;
  return true;
}

function normalizeUserPrompt(userPrompt: string): string {
  let s = String(userPrompt ?? '')
    .replace(/^\s*user\s*(prompt|request)\s*:\s*/i, '')
    .replace(/\brequest\s*id\s*:\s*[a-z0-9_-]+\b/gi, '')
    .replace(/\brequestid\s*:\s*[a-z0-9_-]+\b/gi, '')
    .replace(/\bstyle\s*intent\s*:\s*[^.]+\.?/gi, '')
    .replace(/\bvariation\s*:\s*[^.]+\.?/gi, '')
    .replace(/\bnegative\s*prompt\s*:\s*.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  s = s.replace(/[.]{2,}/g, '.').replace(/[,]{2,}/g, ',').replace(/\s*([.,;:!?])\s*/g, '$1 ').trim();
  s = s.replace(/[.?!;,:\s]+$/g, '').trim();

  // Remove leading command verbs / filler.
  s = s.replace(/^(please\s+)?(create|make|generate|draw|design|produce|render|build)\b\s*/i, '').trim();
  s = s.replace(/^(me\s+)?(a|an|the)\s+/i, '').trim();

  // Normalize ambiguous plurals when the prompt is otherwise singular.
  if (!hasMultiplePeopleIntent(s)) {
    if (s.trim().toLowerCase() === 'women') s = 'a woman';
    if (s.trim().toLowerCase() === 'men') s = 'a man';
  }

  // If the user gave just a bare noun, add an article to keep the injected phrase natural.
  if (s && (isAnimalPrompt(s) || isHumanPrompt(s)) && !/^(a|an|the)\b/i.test(s)) {
    const first = s.split(/\s+/)[0] ?? '';
    if (first && /^[a-z][a-z-]*$/i.test(first)) s = `a ${s}`;
  }

  // Final cleanup: collapse whitespace and avoid stray punctuation sequences like ". ."
  s = s.replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').replace(/\.\s+\./g, '.').trim();
  return s;
}

function buildPhotorealPrompt(args: {
  userRequest: string;
  includeAnimalPersonality?: boolean;
  aspectRatio?: AspectRatio | undefined;
}): string {
  const subject = normalizeUserPrompt(args.userRequest) || 'the requested subject';
  const subjectKind: 'human' | 'animal' | 'generic' = isHumanPrompt(subject)
    ? 'human'
    : isAnimalPrompt(subject)
      ? 'animal'
      : 'generic';

  const humanDetails =
    'Include lifelike human realism: natural skin texture with pores and subtle imperfections, realistic facial anatomy and asymmetry, lifelike eyes with small catchlights and moisture, detailed hair strands, and a natural posture with correct proportions.';
  const animalDetails =
    'Include animal realism micro-details: individual fur strands with natural clumping, subtle asymmetry, whiskers, visible skin/fur transitions, nose texture, and moist eyes with small catchlights; ensure correct anatomy and believable posture.';
  const materialDetails =
    'Include micro-details and subtle imperfections appropriate to the materials (fine grain, tiny scuffs, micro-scratches, natural variation, realistic edges), avoiding plastic smoothness or perfect symmetry.';
  const detailLine = subjectKind === 'human' ? humanDetails : subjectKind === 'animal' ? animalDetails : materialDetails;

  // Keep this as a single paragraph (80–180 words). Avoid adding new subjects; focus on realism + capture cues.
  const paragraph = [
    `Photorealistic, ultra-detailed image of ${subject}, rendered to look completely real at first glance with true-to-life proportions and believable scale.`,
    detailLine,
    'Use a realistic environment/background consistent with the request, with atmospheric depth, natural perspective cues, and physically accurate reflections where relevant.',
    'Lighting should be natural and directional (soft sun or practical light), with gentle shadow falloff, realistic specular highlights, and neutral color balance (no artificial glow, no oversaturation).',
    subjectKind === 'human'
      ? 'Cinematic camera realism: portrait framing focused on the face and upper body unless full-body is requested, shallow depth of field, crisp facial focus with soft background separation, high dynamic range, and clean, believable contrast.'
      : 'Cinematic camera realism: high-end lens feel, shallow depth of field with crisp subject focus and soft background separation, high dynamic range, and clean, believable contrast.',
    args.includeAnimalPersonality ? ANIMAL_PERSONALITY_LINE : null,
    'High resolution, high detail, subtle painterly realism on close inspection (very subtle, not stylized).',
    args.aspectRatio ? `Aspect ratio ${args.aspectRatio}.` : null,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return paragraph;
}

function normalizeUserRequest(s: string): string {
  const out = String(s ?? '')
    .replace(/^\s*user\s*(prompt|request)\s*:\s*/i, '')
    .replace(/\brequest\s*id\s*:\s*[a-z0-9_-]+\b/gi, '')
    .replace(/\brequestid\s*:\s*[a-z0-9_-]+\b/gi, '')
    .replace(/\bstyle\s*intent\s*:\s*[^.]+\.?/gi, '')
    .replace(/\bvariation\s*:\s*[^.]+\.?/gi, '')
    .replace(/\bnegative\s*prompt\s*:\s*.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

function buildStylizedPrompt(args: {
  userRequest: string;
  aspectRatio?: AspectRatio | undefined;
}): string {
  const subject = normalizeUserPrompt(args.userRequest) || 'the requested subject';
  const paragraph = [
    `Highly detailed image of ${subject} in the style the user requested.`,
    'Preserve the user’s intent exactly and keep the scene cohesive and readable, with clean silhouettes, consistent line/shape language, and textures that suit the requested aesthetic.',
    'Use believable lighting direction and shadow placement for depth, avoid muddy colors, and keep proportions stable (no distortions).',
    'Use a clear focal point with thoughtful framing and mild depth cues; avoid clutter and avoid adding unrequested objects.',
    args.aspectRatio ? `Aspect ratio ${args.aspectRatio}.` : null,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return paragraph;
}

function isAnimalPrompt(p: string): boolean {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  // Keep this list small and high-signal to avoid false positives.
  const animals = [
    'animal',
    'dog',
    'cat',
    'kitten',
    'husky',
    'puppy',
    'wolf',
    'fox',
    'tiger',
    'lion',
    'bear',
    'rabbit',
    'bunny',
    'horse',
    'bird',
    'eagle',
    'owl',
    'snake',
    'fish',
  ];
  return animals.some((w) => keywordPattern(w).test(s));
}

function applyApparelModePreface(p: string, mode: ApparelMode): string {
  if (mode === 'none') return String(p ?? '').trim();

  const mockupPreface =
    'Apparel mockup/product photo as requested. Ensure the print/placement is clearly visible and readable. Keep it as a single garment/product presentation; use even lighting with minimal shadows (no drop shadow) unless requested; styling may vary.';
  const fashionPreface =
    'Fashion photo as requested. One person/model wearing the garment; encourage natural pose, movement, and expression. Let background and mood support the scene while keeping the clothing clearly visible.';
  const neutralPreface = 'High quality apparel image. Focus on material, fit, and silhouette; choose a composition that matches the request.';

  const selected = mode === 'mockup' ? mockupPreface : mode === 'fashion' ? fashionPreface : neutralPreface;
  const body = stripKnownApparelPrefacesFromPrompt(String(p ?? ''));
  if (!body) return selected;
  return `${selected} ${body}`.replace(/\s+/g, ' ').trim();
}

function stripBrandSafetyBlockFromPrompt(p: string): { prompt: string; stripped: boolean } {
  const patterns: RegExp[] = [
    /(^|[\s.])no\s+brand\s+names\s*\.?/gi,
    /(^|[\s.])no\s+trademark(ed)?\s+logos?\s*\.?/gi,
    /(^|[\s.])no\s+trademark(ed)?\s+stripes?\s+or\s+signature\s+brand\s+patterns?\s*\.?/gi,
    /(^|[\s.])no\s+adidas\/nike\/puma\s*\.?/gi,
    /(^|[\s.])no\s+sports\s+brand\s+designs?\s*\.?/gi,
  ];

  let out = String(p ?? '');
  let stripped = false;
  for (const re of patterns) {
    const next = out.replace(re, ' ');
    if (next !== out) stripped = true;
    out = next;
  }
  return { prompt: out.replace(/\s+/g, ' ').trim(), stripped };
}

function stripRigidTemplateLinesFromPrompt(p: string): string {
  const patterns: RegExp[] = [
    /(^|[\s.])generate exactly what the user requests\s*\.?/gi,
    /(^|[\s.])do not assume clothing\/apparel unless explicitly requested\s*\.?/gi,
    /(^|[\s.])do not place the design on clothing\s*\.?/gi,
    /(^|[\s.])do not turn it into clothing or apparel\s*\.?/gi,
    /(^|[\s.])isolated on a plain white background\s*\.?/gi,
    /(^|[\s.])flat design on a plain background\s*\.?/gi,
    /(^|[\s.])no clothing mockups?\s*\.?/gi,
  ];
  let out = String(p ?? '');
  for (const re of patterns) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

function addGuidanceLines(p: string, args: { tier: StyleTier; apparelMode: ApparelMode; creativity: number; forcePhotorealNonProduct?: boolean }): string {
  const lines: string[] = [];
  lines.push(styleTierLine(args.tier));

  if (args.forcePhotorealNonProduct) lines.push(NON_PRODUCT_PHOTOREAL_LINE);

  if (args.apparelMode === 'mockup') {
    // Keep structure for mockups, but avoid forcing background/composition outside what the user asked.
    lines.push('Choose a clean presentation that clearly showcases the garment and print placement.');
  } else {
    // Non-apparel prompts should avoid product/studio bias; allow environment and storytelling.
    if (args.apparelMode === 'none') lines.push(NON_APPAREL_ENVIRONMENT_LINE);
    else lines.push(FLEXIBLE_COMPOSITION_LINE);
  }

  lines.push(SOFT_GUIDANCE_LINE);

  // Encourage variation only when creativity is non-trivial.
  if (args.creativity >= 0.3) {
    if (args.apparelMode === 'none') lines.push(NON_APPAREL_VARIATION_LINE);
    else lines.push(CREATIVE_VARIATION_LINE);
  }

  const out = `${lines.join(' ')} ${String(p ?? '').trim()}`.replace(/\s+/g, ' ').trim();
  return out;
}

export function isPromptEnhancerEnabled() {
  return readPromptEnhancerEnv().enabled;
}

export function isPromptEnhancerDebug() {
  return readPromptEnhancerEnv().debug;
}

export function isLetterheadPrompt(p: string) {
  const s = extractUserRequestSegment(p).toLowerCase();
  if (!s.trim()) return false;
  return /\bletter[-\s]?head\b/i.test(s);
}

export function isProductionEnv() {
  return String(process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

export function readPromptEnhancerEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  debug: boolean;
  modelFormatRaw: string;
} {
  return {
    enabled: String(env.PROMPT_ENHANCER_ENABLED ?? 'true').toLowerCase() !== 'false',
    debug: String(env.PROMPT_ENHANCER_DEBUG ?? 'false').toLowerCase() === 'true',
    modelFormatRaw: String(env.PROMPT_ENHANCER_MODEL_FORMAT ?? '').trim().toLowerCase(),
  };
}

export function buildTryOnModelViewConstraints(view: 'front' | 'back'): string {
  const common = [
    // Reference garment preservation (critical)
    'Use the provided reference garment image. The model must wear the exact same garment from the reference image.',
    'Do not change the garment type; do not substitute it with a t-shirt or different clothing item.',
    'Match the garment color, cut, seams, and distinctive features (e.g., hood, pocket, drawstrings, ribbing) if present in the reference.',
    'If the reference garment has a design/print/logo, preserve it in the same position, scale, and colors.',
    'Photorealistic try-on with natural fabric drape and correct proportions.',
    // Outfit consistency + safety
    'Same outfit in every view: do not remove clothing; do not change outfit items between front and back.',
    'If the reference image includes bottoms, preserve them; if the reference is garment-only, add modest neutral bottoms and keep them consistent across views.',
    'Safety: no missing clothing, no underwear, no nudity.',
    // Full-body framing
    'Full body in frame head-to-feet; include extra margin around the body; do not crop the head, feet, arms, or clothing.',
    'Neutral standing pose, arms relaxed, straight-on camera.',
    // Lighting/background (must not override clothing constraints)
    'Clean studio background, even lighting; keep the garment details clearly visible.',
  ].join(' ');

  if (view === 'front') {
    return [
      common,
      'Front view: show a clear human face with visible eyes, nose, mouth; no shadowed/blank/featureless face; hood must not cover the face unless the user explicitly asked.',
      'Negative: no faceless, no featureless head, no mannequin head, no empty hood.',
    ].join(' ');
  }

  return [
    common,
    'Back view: show the back of the garment clearly; ensure any bottoms (present or added) are fully visible and not cropped.',
    'Negative: no missing bottoms, no cropped lower body, no underwear.',
  ].join(' ');
}

// Back-compat export name used by server/index.ts in Convert→Model.
export function buildMaleModelViewConstraints(view: 'front' | 'back'): string {
  return buildTryOnModelViewConstraints(view);
}

export function hashShort(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export function inferAspectRatio(width?: number, height?: number): AspectRatio {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '1:1';
  const r = w / h;
  const ratios: { ar: AspectRatio; value: number }[] = [
    { ar: '1:1', value: 1 },
    { ar: '4:3', value: 4 / 3 },
    { ar: '16:9', value: 16 / 9 },
    { ar: '9:16', value: 9 / 16 },
  ];
  let best = ratios[0]!;
  let bestDiff = Infinity;
  for (const candidate of ratios) {
    const diff = Math.abs(r - candidate.value);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best.ar;
}

export function deriveModelFormatFromEnv(): ModelFormat {
  // This backend currently targets Gemini image generation; treat it as "sdxl" formatting by default.
  const raw = readPromptEnhancerEnv().modelFormatRaw;
  if (raw === 'midjourney') return 'midjourney';
  if (raw === 'generic') return 'generic';
  return 'sdxl';
}

export function maybeEnhancePrompt(
  userPrompt: string,
  options: EnhanceOptions,
  logLabel: string
): { promptForModel: string; negativePrompt: string | null; enhancedHash: string | null } {
  const enabled = isPromptEnhancerEnabled();
  if (!enabled) return { promptForModel: userPrompt, negativePrompt: null, enhancedHash: null };

  const apparelDetected = isApparelOrFashionPrompt(userPrompt);
  const firstApparelKeyword = apparelDetected ? detectFirstApparelKeyword(userPrompt) : null;
  const mockupDetected = apparelDetected && isGarmentMockupPrompt(userPrompt);
  const fashionDetected = apparelDetected && !mockupDetected && isFashionModelPrompt(userPrompt);
  const apparelMode: ApparelMode = mockupDetected ? 'mockup' : fashionDetected ? 'fashion' : apparelDetected ? 'neutral' : 'none';

  const creativity = Number(options?.creativity ?? 0.3);
  const forcePhotorealNonProduct = shouldForcePhotorealNonProduct(userPrompt, apparelMode);
  const creativityEffective = forcePhotorealNonProduct ? 1 : creativity;
  const tier = forcePhotorealNonProduct ? 'realistic' : styleTierFromCreativity(creativity);
  const creativeModeApplied = apparelMode === 'none';

  let promptForEnhancer = userPrompt;
  promptForEnhancer = stripApparelBlockingLinesFromPrompt(promptForEnhancer);
  promptForEnhancer = stripRigidTemplateLinesFromPrompt(promptForEnhancer);
  // Always remove known internal prefaces so they can't "leak" when detection fails.
  promptForEnhancer = stripKnownApparelPrefacesFromPrompt(promptForEnhancer);

  const brandStrip = stripBrandSafetyBlockFromPrompt(promptForEnhancer);
  promptForEnhancer = brandStrip.prompt;

  // Apply mode-based apparel preface ONLY for apparel modes.
  promptForEnhancer = applyApparelModePreface(promptForEnhancer, apparelMode);

  const baseUserRequestForEnhancement = promptForEnhancer;

  // Optional: animal prompts get an extra nudge toward emotion/motion (non-apparel only).
  if (apparelMode === 'none' && isAnimalPrompt(promptForEnhancer)) {
    promptForEnhancer = `${ANIMAL_PERSONALITY_LINE} ${promptForEnhancer}`.replace(/\s+/g, ' ').trim();
  }

  promptForEnhancer = addGuidanceLines(promptForEnhancer, {
    tier,
    apparelMode,
    creativity: creativityEffective,
    forcePhotorealNonProduct,
  });

  let enhancedPrompt: string;
  let negativePrompt: string;
  const letterheadDetected = isLetterheadPrompt(userPrompt);

  const canUseGptStyleNoneMode = apparelMode === 'none' && !isGraphicOrDesignPrompt(userPrompt);

  if (canUseGptStyleNoneMode) {
    const userRequest = extractUserRequestSegment(baseUserRequestForEnhancement);
    const kind: 'human' | 'animal' | 'generic' = isHumanPrompt(userRequest)
      ? 'human'
      : isAnimalPrompt(userRequest)
        ? 'animal'
        : 'generic';
    if (forcePhotorealNonProduct) {
      enhancedPrompt = `${buildPhotorealPrompt({
        userRequest,
        includeAnimalPersonality: isAnimalPrompt(baseUserRequestForEnhancement),
        aspectRatio: options?.aspectRatio,
      })}\n${buildNegativePromptLine({ kind })}`.trim();
      negativePrompt = enhancePrompt('', options).negativePrompt;
    } else if (userRequestedNonPhotorealStyle(userPrompt)) {
      enhancedPrompt = `${buildStylizedPrompt({
        userRequest,
        aspectRatio: options?.aspectRatio,
      })}\n${buildNegativePromptLine({ kind, minimal: true })}`.trim();
      negativePrompt = enhancePrompt('', options).negativePrompt;
    } else {
      // Fallback: still output a photoreal paragraph when none-mode is eligible, even if forcePhotorealNonProduct is false.
      enhancedPrompt = `${buildPhotorealPrompt({
        userRequest,
        includeAnimalPersonality: isAnimalPrompt(baseUserRequestForEnhancement),
        aspectRatio: options?.aspectRatio,
      })}\n${buildNegativePromptLine({ kind })}`.trim();
      negativePrompt = enhancePrompt('', options).negativePrompt;
    }
  } else {
    const effectiveOptions: EnhanceOptions = {
      ...options,
      creativity: creativityEffective,
      stylePreset: forcePhotorealNonProduct
        ? mergeStylePreset(options?.stylePreset, NON_PRODUCT_PHOTOREAL_STYLE_PRESET)
        : options?.stylePreset,
    };

    const out = enhancePrompt(promptForEnhancer, effectiveOptions);
    enhancedPrompt = out.enhancedPrompt;
    negativePrompt = out.negativePrompt;
  }

  // For graphic/design prompts (logo, branding, stationery), prefer stationery-focused
  // phrasing and avoid photographic terms that aren't appropriate for print/branding.
  if (isGraphicOrDesignPrompt(userPrompt)) {
    const photoRegex = /\b(cinematic|golden hour|shallow depth of field|35mm|bokeh|photorealistic|film|natural ambient lighting|dramatic lighting|studio lighting|soft natural light|high dynamic range|rim lighting|volumetric light|neon accent lighting|dreamy glow)\b/gi;
    enhancedPrompt = String(enhancedPrompt ?? '').replace(photoRegex, '');
    enhancedPrompt = enhancedPrompt.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();

    const letterheadPreface =
      'Professional typographic hierarchy, clean white background, ample whitespace and balanced margins, vector-ready logo, print-ready layout. ONE LOGO ONLY. Ensure top-left logo placement only (do NOT center). 12mm safe margins for print (do not place important elements within 12mm of edges). Provide a monochrome (black-on-white) logo variant for print, optional top-right accent band, footer row for contact details, and a subtle diagonal watermark for branding.';

    const stationeryPreface = letterheadDetected
      ? letterheadPreface
      : 'Professional typographic hierarchy, clean white background, ample whitespace and balanced margins, vector-ready logo, print-ready layout.';
    enhancedPrompt = `${stationeryPreface} ${enhancedPrompt}`.replace(/\s+/g, ' ').trim();

    // Don't accidentally block logos/text for graphic outputs.
    negativePrompt = String(negativePrompt ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((x) => x && !/^(logo|text|watermark)$/i.test(x))
      .join(', ');

    // Remove photography/camera guidance and composition lines that don't apply to print/branding.
    enhancedPrompt = enhancedPrompt.replace(/Style intent:[^.]*\./gi, '');
    enhancedPrompt = enhancedPrompt.replace(/Choose a [^.]*environment that enhances the subject\.?/gi, '');
    enhancedPrompt = enhancedPrompt.replace(/Avoid adding elements that were not explicitly requested by the user\./gi, '');
    enhancedPrompt = enhancedPrompt.replace(/Avoid adding elements that were not explicitly requested\b/gi, '');
    const compositionRegex = /\b(dynamic perspective|rule of thirds|leading lines|symmetrical framing|candid moment framing|negative space|wide angle perspective|dynamic angle|bokeh|shallow depth of field|shallow depth|rim lighting|dramatic lighting|golden hour|neon accent lighting|dreamy glow)\b/gi;
    enhancedPrompt = enhancedPrompt.replace(compositionRegex, '');

    // Re-clean punctuation/spacing leftovers.
    enhancedPrompt = enhancedPrompt.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*$/g, '').trim();
  }

  const hash = hashShort(enhancedPrompt);

  const debug = isPromptEnhancerDebug();
  const isProd = isProductionEnv();

  if (!isProd && apparelMode !== 'mockup') {
    if (/one garment only|apparel\/garment design mock\s*up|apparel mockup\/product photo/i.test(enhancedPrompt)) {
      throw new Error(
        `[PromptEnhancer:${logLabel}] Mockup preface leaked while mode=${apparelMode}.`
      );
    }
  }

  if (!isProd && apparelMode === 'none') {
    if (/apparel mockup\/product photo|fashion photo as requested|high[-\s]*quality\s+apparel\/garment/i.test(enhancedPrompt)) {
      throw new Error(`[PromptEnhancer:${logLabel}] Apparel preface leaked while mode=none.`);
    }
  }

  if (debug && !isProd) {
    console.log(`[PromptEnhancer:${logLabel}]`, {
      apparelDetected,
      mockupDetected,
      fashionDetected,
      mode: apparelMode,
      firstApparelKeyword,
      creativity,
      creativityEffective,
      styleTier: tier,
      creativeModeApplied,
      forcePhotorealNonProduct,
      enhancedPrompt,
    });
  } else {
    // Never log the full enhanced prompt in production.
    console.log(
      `[PromptEnhancer:${logLabel}]`,
      debug
        ? {
          apparelDetected,
          mockupDetected,
          fashionDetected,
          mode: apparelMode,
          firstApparelKeyword,
          creativity,
          creativityEffective,
          styleTier: tier,
          creativeModeApplied,
          forcePhotorealNonProduct,
          hash,
        }
        : { hash }
    );
  }

  return { promptForModel: enhancedPrompt, negativePrompt, enhancedHash: hash };
}
