import { useMemo, useRef, useState, useEffect, useLayoutEffect, type ReactNode, type CSSProperties } from 'react';
import {
  Sparkles,
  Wand2,
  Loader2,
  Camera,
  ArrowDownToLine,
  Maximize2,
  Palette,
  AlertCircle,
  ImageDown,
  ShieldCheck,
  Plus,
  X,
  Users,
  ChevronDown,
  Check,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { authFetch, getUserId, resolveApiAssetUrl } from '../utils/auth';
import { TOOLBAR_ICON_BTN, TOOLBAR_PILL_BTN } from './ui/toolbarStyles';
import { ListingAssistantInline } from './ListingAssistantInline';

type ArtStyleKey = 'realistic' | '3d' | 'lineart' | 'watercolor';
type ViewKey = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'closeUp' | 'top';
type FramingMode = 'preserve' | 'zoomIn' | 'zoomOut';
type MannequinModelKey = 'male' | 'female';

interface AIImageGeneratorProps {
  onGenerate?: (composite: string) => void;
}

interface GeneratedImage {
  view: ViewKey;
  src: string;
  imageBase64?: string;
  width?: number;
  height?: number;
}

interface GenerateResponse {
  composite: string;
  images: GeneratedImage[];
  designId?: string;
}

type GeneratedVariant = {
  id: string;
  kind?: 'base' | 'style_converted' | 'model_preview';
  styleLabel: string;
  styleKey?: ArtStyleKey;
  modelLabel?: string;
  modelKey?: MannequinModelKey;
  views: ViewKey[];
  composite: string;
  images: GeneratedImage[];
};

interface SingleEditResponse {
  imageDataUrl: string;
}

const resolutionOptions = [512, 1024, 1536, 2048];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ACCEPTED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const PADDING_PERCENT = 0.25;

const formatResolution = (size: number) => `${size} × ${size}`;

const styleOptions: { id: ArtStyleKey; label: string; preview: string; helper: string }[] = [
  {
    id: 'realistic',
    label: 'Realistic',
    preview: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&h=400&fit=crop',
    helper: 'photorealistic, natural lighting',
  },
  {
    id: '3d',
    label: '3D Render',
    preview: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=400&h=400&fit=crop',
    helper: 'PBR, studio light, CGI',
  },
  {
    id: 'lineart',
    label: 'Line Art',
    preview: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=400&h=400&fit=crop',
    helper: 'ink on white, no shading',
  },
  {
    id: 'watercolor',
    label: 'Watercolor',
    preview: 'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=400&h=400&fit=crop',
    helper: 'soft edges, paper grain',
  },
];

const viewOptions: { id: ViewKey; label: string }[] = [
  { id: 'front', label: 'Front View' },
  { id: 'back', label: 'Back View' },
  { id: 'left', label: 'Left Side' },
  { id: 'right', label: 'Right Side' },
  { id: 'threeQuarter', label: '3/4 View' },
  { id: 'closeUp', label: 'Close-up View' },
];

const viewLabel = (view: ViewKey) => viewOptions.find((v) => v.id === view)?.label ?? view;

const VIEW_ORDER: ViewKey[] = ['front', 'back', 'left', 'right', 'threeQuarter', 'closeUp', 'top'];

function normalizeViews(selectedViews: ViewKey[]): ViewKey[] {
  const normalized = new Set<ViewKey>(selectedViews);
  normalized.add('front');
  return VIEW_ORDER.filter((v) => normalized.has(v));
}

const appendPromptModifier = (prompt: string, modifier: string) => {
  const trimmedPrompt = prompt.trim();
  const trimmedModifier = modifier.trim();
  if (!trimmedModifier) return trimmedPrompt;
  if (!trimmedPrompt) return trimmedModifier;
  const needsPunctuation = !/[.!?]$/.test(trimmedPrompt);
  return `${trimmedPrompt}${needsPunctuation ? '.' : ''} ${trimmedModifier}`;
};

function userRequestedBrand(prompt: string): boolean {
  const p = (prompt || '').toLowerCase();
  if (!p.trim()) return false;

  // Explicit brand keywords or "in the style of" style requests.
  const brands = [
    'adidas',
    'nike',
    'puma',
    'reebok',
    'under armour',
    'underarmour',
    'new balance',
    'asics',
    'fila',
    'converse',
    'vans',
    'jordan',
  ];
  if (brands.some((b) => p.includes(b))) return true;
  if (/\b(in the style of|brand(ed)?|logo(ed)?|trademark(ed)?)\b/.test(p)) return true;
  return false;
}

type DesignCategory = 'apparel' | 'logo' | 'poster' | 'product' | 'illustration' | 'generic';

function detectDesignCategory(userPrompt: string): DesignCategory {
  const p = (userPrompt || '').toLowerCase();

  const apparel = [
    'shirt',
    't-shirt',
    'tshirt',
    'hoodie',
    'suit',
    'cap',
    'hat',
    'jacket',
    'pants',
    'trousers',
    'dress',
    'clothing',
    'apparel',
    'garment',
    'uniform',
  ];
  const logo = ['logo', 'emblem', 'brandmark', 'icon'];
  const poster = ['poster', 'flyer', 'banner', 'advertisement', 'ad'];
  const product = ['packaging', 'label', 'bottle', 'box'];
  const illustration = ['character', 'illustration', 'drawing', 'art', 'cartoon'];

  const includesAny = (words: string[]) => words.some((w) => p.includes(w));

  if (includesAny(apparel)) return 'apparel';
  if (includesAny(logo)) return 'logo';
  if (includesAny(poster)) return 'poster';
  if (includesAny(product)) return 'product';
  if (includesAny(illustration)) return 'illustration';
  return 'generic';
}

const BRAND_SAFE_NEGATIVE =
  'No brand names. No trademarked logos. No trademarked stripes or signature brand patterns. No Adidas/Nike/Puma. No sports brand designs.';

function applyBrandSafety(prompt: string): string {
  if (userRequestedBrand(prompt)) return prompt.trim();
  return appendPromptModifier(prompt, BRAND_SAFE_NEGATIVE);
}

function applyCategoryTemplate(userPrompt: string): { prompt: string; category: DesignCategory } {
  const category = detectDesignCategory(userPrompt);
  const base = userPrompt.trim();

  const genericGuard =
    'Generate exactly what the user requests. Do not assume clothing/apparel unless explicitly requested.';
  const nonApparelNegative = 'No clothing. No t-shirt. No hoodie. No suit. No apparel mockup.';

  if (category === 'apparel') {
    return {
      category,
      prompt: [
        'High quality apparel/garment design mockup. One garment only, centered, clean background.',
        'Keep the garment fully visible.',
        `User request: ${base}`,
      ].join(' '),
    };
  }

  if (category === 'logo') {
    return {
      category,
      prompt: [
        'High resolution logo design. Vector-like, clean edges, crisp lines.',
        'Isolated on a plain white background. No mockups.',
        genericGuard,
        nonApparelNegative,
        `User request: ${base}`,
      ].join(' '),
    };
  }

  if (category === 'poster') {
    return {
      category,
      prompt: [
        'High quality poster/flyer design. Strong typography and layout, clean margins.',
        'Flat design on a plain background. No clothing mockups.',
        genericGuard,
        nonApparelNegative,
        `User request: ${base}`,
      ].join(' '),
    };
  }

  if (category === 'product') {
    return {
      category,
      prompt: [
        'High quality product design / packaging concept. Clean presentation.',
        'Do not place the design on clothing.',
        genericGuard,
        nonApparelNegative,
        `User request: ${base}`,
      ].join(' '),
    };
  }

  if (category === 'illustration') {
    return {
      category,
      prompt: [
        'High quality illustration. Sharp details, clean lines.',
        'Do not turn it into clothing or apparel.',
        genericGuard,
        nonApparelNegative,
        `User request: ${base}`,
      ].join(' '),
    };
  }

  return {
    category,
    prompt: [genericGuard, nonApparelNegative, `User request: ${base}`].join(' '),
  };
}

const framingModeLabel = (mode: FramingMode) => {
  if (mode === 'zoomIn') return 'Zoomed in';
  if (mode === 'zoomOut') return 'Zoomed out';
  return 'Preserve framing';
};

const framingPromptModifier = (mode: FramingMode) => {
  if (mode === 'zoomIn') {
    return 'Zoom in closer to the product. Fill most of the frame. Keep subject centered and fully visible (no cropping). Maintain the same camera angle.';
  }
  if (mode === 'zoomOut') {
    return 'Zoom out slightly to show more surrounding space around the product. Keep subject centered and fully in frame. Maintain the same camera angle.';
  }
  return 'Keep the full product visible. Do not zoom in. Maintain the same framing, same camera distance, and same size as original. Keep subject centered and fully in frame.';
};

const WHITE_BACKGROUND_PROMPT =
  'Background: pure white (#FFFFFF), seamless, flat white backdrop. No gray studio box, no gradients, no shadows, no reflections, no vignette.';

const THREE_D_NO_MANNEQUIN_PROMPT =
  'Product-only 3D render of the uniform/apparel. Uniform only, floating apparel / ghost mannequin style. No mannequin, no statue, no person, no human, no body, no character, no dummy, no stand.';

const MODEL_NO_MANNEQUIN_PROMPT =
  'Human model wearing the uniform. No mannequin, no statue, no dummy, no stand. Keep the same uniform design, colors, and patterns.';

const readFileAsDataUrl = async (file: File) => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });
};

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load generated image.'));
    img.src = src;
  });
}

type ContentBounds = { left: number; top: number; right: number; bottom: number };

function unionBounds(a: ContentBounds | null, b: ContentBounds | null): ContentBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function cropCanvasToBoundsWithPadding(
  canvas: HTMLCanvasElement,
  bounds: ContentBounds,
  {
    paddingPercent = 0.25,
    minPaddingPx = 120,
    verticalPaddingMultiplier = 1.2,
  }: { paddingPercent?: number; minPaddingPx?: number; verticalPaddingMultiplier?: number } = {}
): HTMLCanvasElement {
  const { width, height } = canvas;
  const contentW = Math.max(1, bounds.right - bounds.left + 1);
  const contentH = Math.max(1, bounds.bottom - bounds.top + 1);

  const basePad = Math.max(minPaddingPx, Math.max(contentW, contentH) * paddingPercent);
  const padX = Math.round(basePad);
  const padY = Math.round(basePad * verticalPaddingMultiplier);

  let x = Math.floor(bounds.left - padX);
  let y = Math.floor(bounds.top - padY);
  let w = Math.ceil(contentW + padX * 2);
  let h = Math.ceil(contentH + padY * 2);

  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(width - x, w);
  h = Math.min(height - y, h);

  if (w <= 0 || h <= 0) return canvas;
  if (x === 0 && y === 0 && w === width && h === height) return canvas;

  const out = document.createElement('canvas');
  out.width = Math.max(1, w);
  out.height = Math.max(1, h);
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  if (!outCtx) return canvas;

  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function cropCanvasLoose(canvas: HTMLCanvasElement, paddingPercent = 0.25): HTMLCanvasElement {
  const b1 = getContentBounds(canvas, { treatNearWhiteAsEmpty: true });
  const b2 = getContentBounds(canvas, { treatNearWhiteAsEmpty: false });
  const bounds = unionBounds(b1, b2);
  if (!bounds) return canvas;

  // First pass (loose).
  let out = cropCanvasToBoundsWithPadding(canvas, bounds, { paddingPercent, minPaddingPx: 120, verticalPaddingMultiplier: 1.2 });

  // Safeguard: if content still touches edges, increase padding and redo.
  const postBounds = getContentBounds(out, { treatNearWhiteAsEmpty: false });
  if (postBounds) {
    const marginLeft = postBounds.left;
    const marginTop = postBounds.top;
    const marginRight = out.width - 1 - postBounds.right;
    const marginBottom = out.height - 1 - postBounds.bottom;

    const minMargin = 48; // keep some guaranteed whitespace in the final crop
    if (Math.min(marginLeft, marginTop, marginRight, marginBottom) < minMargin) {
      out = cropCanvasToBoundsWithPadding(canvas, bounds, {
        paddingPercent: Math.max(0.35, paddingPercent),
        minPaddingPx: 160,
        verticalPaddingMultiplier: 1.3,
      });
    }
  }

  return out;
}

async function autoCropWhiteBackground(imageUrl: string, paddingPercent = 0.25): Promise<string> {
  const trimmedSrc = String(imageUrl || '').trim();
  if (!trimmedSrc) throw new Error('Missing image source.');

  const isDataUrl = /^data:image\//i.test(trimmedSrc);
  let objectUrlToRevoke: string | null = null;

  try {
    let img: HTMLImageElement;
    if (isDataUrl) {
      img = await loadImageElement(trimmedSrc);
    } else {
      const res = trimmedSrc.startsWith('/api/') ? await authFetch(trimmedSrc) : await fetch(trimmedSrc);
      if (!res.ok) throw new Error('Failed to load image for cropping.');
      const blob = await res.blob();
      objectUrlToRevoke = URL.createObjectURL(blob);
      img = await loadImageElement(objectUrlToRevoke);
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return trimmedSrc;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return trimmedSrc;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    normalizeCanvasBackgroundToWhite(canvas);

    const b1 = getContentBounds(canvas, { treatNearWhiteAsEmpty: true });
    const b2 = getContentBounds(canvas, { treatNearWhiteAsEmpty: false });
    const bounds = unionBounds(b1, b2);
    if (!bounds) return trimmedSrc;

    const boundsW = Math.max(1, bounds.right - bounds.left + 1);
    const boundsH = Math.max(1, bounds.bottom - bounds.top + 1);

    const paddingX = Math.max(120, Math.round(boundsW * paddingPercent));
    const paddingY = Math.max(144, Math.round(boundsH * paddingPercent * 1.2));

    const cropX = Math.max(0, bounds.left - paddingX);
    const cropY = Math.max(0, bounds.top - paddingY);
    const cropRight = Math.min(width - 1, bounds.right + paddingX);
    const cropBottom = Math.min(height - 1, bounds.bottom + paddingY);
    const cropW = Math.max(1, cropRight - cropX + 1);
    const cropH = Math.max(1, cropBottom - cropY + 1);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d', { willReadFrequently: true });
    if (!outCtx) return trimmedSrc;

    outCtx.imageSmoothingEnabled = true;
    // @ts-expect-error some TS libdom versions type this as limited values
    outCtx.imageSmoothingQuality = 'high';
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, width, height);

    const scale = Math.min(width / cropW, height / cropH);
    const destW = cropW * scale;
    const destH = cropH * scale;
    const destX = (width - destW) / 2;
    const destY = (height - destH) / 2;

    outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, destX, destY, destW, destH);

    return out.toDataURL('image/png');
  } finally {
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
  }
}

async function getImageSize(url: string): Promise<{ width: number; height: number }> {
  const img = await loadImageElement(url);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  return { width, height };
}

async function ensurePngDataUrlSquareSize(dataUrl: string, target: number): Promise<string> {
  const src = String(dataUrl || '').trim();
  if (!src.startsWith('data:image/')) return src;
  if (!Number.isFinite(target) || target <= 0) return src;

  const { width, height } = await getImageSize(src);
  if (width === target && height === target) return src;

  console.warn('[AIImageGenerator] Wrong resolution returned, fixing:', { expected: target, actual: `${width}x${height}` });

  const img = await loadImageElement(src);
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return src;

  ctx.imageSmoothingEnabled = true;
  // @ts-expect-error some TS libdom versions type this as limited values
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target, target);

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(target / iw, target / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (target - dw) / 2;
  const dy = (target - dh) / 2;
  ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);

  return canvas.toDataURL('image/png');
}

async function fitImageToFrame(imageUrl: string, targetSize: number, paddingRatio = 0.06): Promise<string> {
  const src = String(imageUrl || '').trim();
  if (!src) throw new Error('Missing image source.');
  if (!Number.isFinite(targetSize) || targetSize <= 0) throw new Error('Invalid target size.');

  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('Invalid image dimensions.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas not supported.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  // Reduce “ghost” gray background noise so content bounds are tighter and more consistent.
  normalizeCanvasBackgroundToWhite(canvas, { bgDistanceThreshold: 40, minBrightness: 150 });

  const detectBounds = () => {
    // Prefer a density-based bbox (robust to tiny noise specks far from the subject).
    try {
      const downsample = 256;
      const scale = Math.min(1, downsample / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const small = document.createElement('canvas');
      small.width = w;
      small.height = h;
      const sctx = small.getContext('2d', { willReadFrequently: true });
      if (sctx) {
        sctx.imageSmoothingEnabled = true;
        // @ts-expect-error some TS libdom versions type this as limited values
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(canvas, 0, 0, w, h);

        const data = sctx.getImageData(0, 0, w, h).data;
        const rowCounts = new Uint32Array(h);
        const colCounts = new Uint32Array(w);
        // Treat very light pixels as background so shadows/halos don’t inflate the bbox.
        const nonWhiteThreshold = 245;

        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            if (a === 0) continue;
            if (r >= nonWhiteThreshold && g >= nonWhiteThreshold && b >= nonWhiteThreshold) continue;
            rowCounts[y] += 1;
            colCounts[x] += 1;
          }
        }

        // Ignore sparse specks by requiring a small minimum density per row/column.
        const minFraction = 0.01;
        const rowMin = Math.max(2, Math.round(w * minFraction));
        const colMin = Math.max(2, Math.round(h * minFraction));

        let top = 0;
        while (top < h && rowCounts[top] < rowMin) top += 1;
        let bottom = h - 1;
        while (bottom >= 0 && rowCounts[bottom] < rowMin) bottom -= 1;
        let left = 0;
        while (left < w && colCounts[left] < colMin) left += 1;
        let right = w - 1;
        while (right >= 0 && colCounts[right] < colMin) right -= 1;

        if (right >= left && bottom >= top) {
          const inv = 1 / scale;
          return {
            left: Math.max(0, Math.floor(left * inv)),
            top: Math.max(0, Math.floor(top * inv)),
            right: Math.min(width - 1, Math.ceil((right + 1) * inv) - 1),
            bottom: Math.min(height - 1, Math.ceil((bottom + 1) * inv) - 1),
          };
        }
      }
    } catch {
      // fall back
    }

    // Fallback: pick the tightest near-white bounds (avoid the non-filtered bounds which becomes full-canvas).
    const candidates = [
      getContentBounds(canvas, { treatNearWhiteAsEmpty: true, nearWhiteThreshold: 240 }),
      getContentBounds(canvas, { treatNearWhiteAsEmpty: true, nearWhiteThreshold: 245 }),
      getContentBounds(canvas, { treatNearWhiteAsEmpty: true, nearWhiteThreshold: 250 }),
      getContentBounds(canvas, { treatNearWhiteAsEmpty: true, nearWhiteThreshold: 252 }),
    ].filter(Boolean) as { left: number; top: number; right: number; bottom: number }[];

    if (!candidates.length) return null;

    const minAreaFraction = 0.02; // ignore absurdly tiny detections
    const fullArea = width * height;
    const scored = candidates
      .map((b) => ({
        b,
        area: (b.right - b.left + 1) * (b.bottom - b.top + 1),
      }))
      .filter((x) => x.area / fullArea >= minAreaFraction)
      .sort((a, b) => a.area - b.area);

    return (scored[0]?.b ?? candidates[0]) || null;
  };

  const renderFit = (
    bounds: { left: number; top: number; right: number; bottom: number },
    padRatio: number,
    minPad: number
  ) => {
    const bboxW = Math.max(1, bounds.right - bounds.left + 1);
    const bboxH = Math.max(1, bounds.bottom - bounds.top + 1);

    // Aim for consistent framing across views: subject fills ~92% of the output.
    const targetFill = 0.92;
    const desiredSide = Math.ceil(Math.max(bboxW / targetFill, bboxH / targetFill));

    const paddingX = Math.max(minPad, Math.round(bboxW * padRatio));
    const paddingY = Math.max(minPad, Math.round(bboxH * padRatio * 1.05));
    const minSide = Math.max(bboxW + paddingX * 2, bboxH + paddingY * 2);

    const cropSide = Math.max(1, Math.min(Math.max(desiredSide, minSide), Math.min(width, height)));
    const cx = (bounds.left + bounds.right) / 2;
    const cy = (bounds.top + bounds.bottom) / 2;

    let cropX = Math.round(cx - cropSide / 2);
    let cropY = Math.round(cy - cropSide / 2);
    cropX = Math.max(0, Math.min(width - cropSide, cropX));
    cropY = Math.max(0, Math.min(height - cropSide, cropY));
    const cropW = cropSide;
    const cropH = cropSide;

    const out = document.createElement('canvas');
    out.width = targetSize;
    out.height = targetSize;
    const outCtx = out.getContext('2d', { willReadFrequently: true });
    if (!outCtx) throw new Error('Canvas not supported.');

    outCtx.imageSmoothingEnabled = true;
    // @ts-expect-error some TS libdom versions type this as limited values
    outCtx.imageSmoothingQuality = 'high';
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, targetSize, targetSize);

    // Square crop -> square output (no extra letterboxing).
    outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, targetSize, targetSize);

    return out;
  };

  const bounds = detectBounds();
  if (!bounds) return src;

  // First pass: tight fit.
  const minPad1 = 0;
  let out = renderFit(bounds, paddingRatio, minPad1);

  // Auto-tighten: if subject still doesn't fill the frame enough, run a second tighter pass.
  const postBounds = getContentBounds(out, { treatNearWhiteAsEmpty: true, nearWhiteThreshold: 245 });
  if (postBounds) {
    const fillW = (postBounds.right - postBounds.left + 1) / targetSize;
    const fillH = (postBounds.bottom - postBounds.top + 1) / targetSize;
    if (Math.min(fillW, fillH) < 0.94) {
      const minPad2 = 0;
      out = renderFit(bounds, Math.max(0, paddingRatio * 0.25), minPad2);
    }
  }

  console.log('Final fitted image size should be:', targetSize);
  return out.toDataURL('image/png');
}

function promptRequestsNonWhiteBackgroundClient(promptRaw: string): boolean {
  const p = (promptRaw || '').toLowerCase().trim();
  if (!p) return false;
  if (p.includes('#ffffff') || p.includes('pure white') || p.includes('plain white') || p.includes('white background')) return false;
  if (p.includes('transparent background') || p.includes('checkerboard')) return true;
  if (p.includes('gradient background') || p.includes('pattern background') || p.includes('textured background')) return true;
  if (/\b(background|backdrop)\b/.test(p) && /\b(black|blue|red|green|yellow|pink|purple|orange|grey|gray|color(ed)?|colou?r(ed)?)\b/.test(p)) return true;
  if (/\b(outdoors?|outdoor)\b/.test(p)) return true;
  if (/\b(studio scene|studio set|in a studio|in the studio)\b/.test(p)) return true;
  if (/\b(in|on|at)\s+(a|the)\s+(room|interior|street|city|forest|beach|mountain|park)\b/.test(p)) return true;
  if (/\b(environment|scene)\b/.test(p) && !/\b(no|without)\s+(environment|scene)\b/.test(p)) return true;
  return false;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function exportImageAtScale(imageUrl: string, scale: number): Promise<Blob> {
  const src = String(imageUrl || '').trim();
  if (!src) throw new Error('Missing image source.');

  const s = Number.isFinite(scale) ? Number(scale) : 1;
  const safeScale = Math.max(1, Math.min(8, s));

  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('Invalid image dimensions.');

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * safeScale));
  canvas.height = Math.max(1, Math.round(height * safeScale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas not supported.');

  ctx.imageSmoothingEnabled = true;
  // @ts-expect-error some TS libdom versions type this as limited values
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(safeScale, 0, 0, safeScale, 0, 0);
  ctx.drawImage(img, 0, 0, width, height);

  console.log('Export size:', canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('Failed to export image.'));
      else resolve(blob);
    }, 'image/png');
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read blob.'));
    reader.readAsDataURL(blob);
  });
}

async function downloadPng(imageUrl: string, filename: string, scale = 1) {
  const safeName = filename?.trim() ? filename.trim() : 'image.png';
  if (scale <= 1) {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = safeName;
    link.click();
    return;
  }

  const blob = await exportImageAtScale(imageUrl, scale);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = safeName;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function computePreviewScaleFromImageSrc(
  src: string,
  {
    targetFillRatio = 0.85,
    nearWhiteThreshold = 250,
    maxScale = 2.8,
  }: { targetFillRatio?: number; nearWhiteThreshold?: number; maxScale?: number } = {}
): Promise<number> {
  if (!src) return 1;

  const trimmed = src.trim();
  const isDataUrl = /^data:image\//i.test(trimmed);
  let objectUrlToRevoke: string | null = null;

  try {
    let img: HTMLImageElement;
    if (isDataUrl) {
      img = await loadImageElement(trimmed);
    } else {
      const res = trimmed.startsWith('/api/') ? await authFetch(trimmed) : await fetch(trimmed);
      if (!res.ok) return 1;
      const blob = await res.blob();
      objectUrlToRevoke = URL.createObjectURL(blob);
      img = await loadImageElement(objectUrlToRevoke);
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return 1;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 1;

    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;

    let top = height;
    let bottom = -1;
    let left = width;
    let right = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        const isEmpty = a === 0 || (r >= nearWhiteThreshold && g >= nearWhiteThreshold && b >= nearWhiteThreshold);
        if (isEmpty) continue;

        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }

    if (bottom < top || right < left) return 1;

    const bboxHeight = bottom - top + 1;
    const bboxWidth = right - left + 1;
    const fillRatioH = bboxHeight / height;
    const fillRatioW = bboxWidth / width;
    if (!Number.isFinite(fillRatioH) || !Number.isFinite(fillRatioW) || fillRatioH <= 0 || fillRatioW <= 0) return 1;

    const needed = Math.max(targetFillRatio / fillRatioH, targetFillRatio / fillRatioW);
    const scale = clamp(needed, 1, maxScale);
    return scale;
  } catch {
    return 1;
  } finally {
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
  }
}

function AutoScaledPreviewImage({
  src,
  alt,
  className,
  style,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        ...style,
      }}
    />
  );
}

function PreviewFrame({
  className,
  maxHeightClassName = 'max-h-[280px]',
  children,
}: {
  className?: string;
  maxHeightClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'w-full aspect-square rounded-xl overflow-hidden border border-slate-200 bg-white flex items-center justify-center',
        maxHeightClassName,
        className
      )}
    >
      {children}
    </div>
  );
}

function previewZoomScaleForView(view?: string) {
  const v = (view || '').toLowerCase();
  if (v === 'left' || v === 'right') return 1.45;
  if (v === 'closeup' || v === 'close_up' || v === 'close-up' || v === 'closeupview') return 1.15;
  if (v === 'top') return 1.25;
  if (v === 'threequarter' || v === 'three_quarter' || v === '3/4' || v === 'threequarterview') return 1.35;
  return 1.35;
}

function PreviewImage({
  src,
  alt,
  view,
}: {
  src: string;
  alt: string;
  view?: string;
}) {
  const scale = previewZoomScaleForView(view);
  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden">
      <AutoScaledPreviewImage
        src={src}
        alt={alt}
        className="w-full h-full"
        style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}
      />
    </div>
  );
}

function ViewItem({
  label,
  url,
  resolution,
  viewKey,
  onDownload,
}: {
  label: string;
  url: string;
  resolution: number;
  viewKey?: ViewKey;
  onDownload: () => void;
}) {
  const maxWidth = Number.isFinite(resolution) && resolution > 0 ? resolution : 1024;

  return (
    <div className="w-full flex flex-col gap-2 items-center">
      <div className="w-full flex items-center justify-between gap-3" style={{ maxWidth }}>
        <h3 className="text-sm font-medium text-slate-900">{label}</h3>
        <button type="button" onClick={onDownload} className="text-purple-600 text-xs hover:underline">
          Download
        </button>
      </div>
      <div className="w-full aspect-square overflow-hidden rounded-md bg-white" style={{ maxWidth }}>
        <div className="w-full h-full flex items-center justify-center overflow-hidden">
          <img
            src={url}
            alt={label}
            className="w-full h-full object-contain"
          />
        </div>
      </div>
    </div>
  );
}

function isProbablyValidPngDataUrl(src: string) {
  const trimmed = String(src || '').trim();
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
  return Boolean(match?.[1] && match[1].length > 1000);
}

function stripPngDataUrl(dataUrl: string) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(String(dataUrl || '').trim());
  return match?.[1] ?? '';
}

function trimCanvasToContent(
  canvas: HTMLCanvasElement,
  {
    treatNearWhiteAsEmpty = true,
    nearWhiteThreshold = 245,
  }: { treatNearWhiteAsEmpty?: boolean; nearWhiteThreshold?: number } = {}
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  const { width, height } = canvas;
  if (!width || !height) return canvas;

  const data = ctx.getImageData(0, 0, width, height).data;

  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      const isNearWhite = r > nearWhiteThreshold && g > nearWhiteThreshold && b > nearWhiteThreshold;
      const isEmpty = a === 0 || (treatNearWhiteAsEmpty && isNearWhite);
      if (isEmpty) continue;

      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return canvas;

  const trimW = right - left + 1;
  const trimH = bottom - top + 1;
  if (trimW <= 0 || trimH <= 0) return canvas;
  if (trimW === width && trimH === height) return canvas;

  const trimmed = document.createElement('canvas');
  trimmed.width = trimW;
  trimmed.height = trimH;

  const tctx = trimmed.getContext('2d', { willReadFrequently: true });
  if (!tctx) return canvas;
  tctx.drawImage(canvas, left, top, trimW, trimH, 0, 0, trimW, trimH);
  return trimmed;
}

function normalizeCanvasBackgroundToWhite(
  canvas: HTMLCanvasElement,
  {
    sampleBorderPx = 12,
    bgDistanceThreshold = 36,
    neutralChannelThreshold = 18,
    minBrightness = 140,
  }: {
    sampleBorderPx?: number;
    bgDistanceThreshold?: number;
    neutralChannelThreshold?: number;
    minBrightness?: number;
  } = {}
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  const { width, height } = canvas;
  if (!width || !height) return canvas;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const border = Math.max(1, Math.min(sampleBorderPx, Math.floor(Math.min(width, height) / 6)));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  const sample = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    const a = data[idx + 3];
    if (a === 0) return;
    sumR += data[idx];
    sumG += data[idx + 1];
    sumB += data[idx + 2];
    count += 1;
  };

  const step = Math.max(1, Math.floor(border / 2));
  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < border; y += step) sample(x, y);
    for (let y = height - border; y < height; y += step) sample(x, y);
  }
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < border; x += step) sample(x, y);
    for (let x = width - border; x < width; x += step) sample(x, y);
  }

  const bgR = count ? sumR / count : 255;
  const bgG = count ? sumG / count : 255;
  const bgB = count ? sumB / count : 255;
  const bgMax = Math.max(bgR, bgG, bgB);
  const bgMin = Math.min(bgR, bgG, bgB);
  const bgIsNeutral = bgMax - bgMin <= neutralChannelThreshold;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
      continue;
    }

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const isNeutral = max - min <= neutralChannelThreshold;
    const brightnessOk = (r + g + b) / 3 >= minBrightness;

    if (!bgIsNeutral || !isNeutral || !brightnessOk) continue;

    const dist = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);
    if (dist <= bgDistanceThreshold) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function getContentBounds(
  canvas: HTMLCanvasElement,
  {
    treatNearWhiteAsEmpty = true,
    nearWhiteThreshold = 245,
  }: { treatNearWhiteAsEmpty?: boolean; nearWhiteThreshold?: number } = {}
): { left: number; top: number; right: number; bottom: number } | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const { width, height } = canvas;
  if (!width || !height) return null;

  const data = ctx.getImageData(0, 0, width, height).data;

  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      const isNearWhite = r > nearWhiteThreshold && g > nearWhiteThreshold && b > nearWhiteThreshold;
      const isEmpty = a === 0 || (treatNearWhiteAsEmpty && isNearWhite);
      if (isEmpty) continue;

      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

function cropCanvasToContent(
  canvas: HTMLCanvasElement,
  {
    targetFillRatio = 0.85,
    paddingPercent = 0.1,
  }: { targetFillRatio?: number; paddingPercent?: number } = {}
): HTMLCanvasElement {
  const bounds =
    getContentBounds(canvas, { treatNearWhiteAsEmpty: true }) ??
    getContentBounds(canvas, { treatNearWhiteAsEmpty: false });
  if (!bounds) return canvas;

  const { width, height } = canvas;
  const contentW = bounds.right - bounds.left + 1;
  const contentH = bounds.bottom - bounds.top + 1;
  if (contentW <= 0 || contentH <= 0) return canvas;

  const padPx = Math.max(contentW, contentH) * paddingPercent;
  const desiredW = Math.max(contentW / targetFillRatio, contentW + padPx * 2);
  const desiredH = Math.max(contentH / targetFillRatio, contentH + padPx * 2);

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;

  let x = Math.floor(centerX - desiredW / 2);
  let y = Math.floor(centerY - desiredH / 2);
  let w = Math.ceil(desiredW);
  let h = Math.ceil(desiredH);

  if (w > width) {
    w = width;
    x = 0;
  } else {
    x = Math.max(0, Math.min(width - w, x));
  }

  if (h > height) {
    h = height;
    y = 0;
  } else {
    y = Math.max(0, Math.min(height - h, y));
  }

  const out = document.createElement('canvas');
  out.width = Math.max(1, w);
  out.height = Math.max(1, h);
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  if (!outCtx) return canvas;

  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

async function composeCompositeFromTiles(tiles: GeneratedImage[], resolution: number): Promise<string> {
  const columns = 2;
  const rows = 2;
  const tileWidth = Math.max(64, Math.floor(resolution / columns));
  const tileHeight = Math.max(64, Math.floor(resolution / rows));

  const canvas = document.createElement('canvas');
  canvas.width = columns * tileWidth;
  canvas.height = rows * tileHeight;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to initialize canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgs = await Promise.all(tiles.map((tile) => loadImageElement(tile.src)));
  imgs.forEach((img, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    ctx.drawImage(img, col * tileWidth, row * tileHeight, tileWidth, tileHeight);
  });

  return canvas.toDataURL('image/png');
}

async function addPaddingToImage(file: File, paddingPercent = PADDING_PERCENT): Promise<File> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = new Image();

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for padding.'));
      img.src = blobUrl;
    });

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (!width || !height) throw new Error('Invalid image dimensions.');

    const newWidth = Math.max(1, Math.round(width * (1 + paddingPercent)));
    const newHeight = Math.max(1, Math.round(height * (1 + paddingPercent)));

    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas not supported.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, newWidth, newHeight);

    const dx = Math.round((newWidth - width) / 2);
    const dy = Math.round((newHeight - height) / 2);
    ctx.drawImage(img, dx, dy, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to export padded PNG.'))), 'image/png');
    });

    const base = file.name?.trim() ? file.name.trim().replace(/\.[^.]+$/, '') : 'upload';
    const paddedName = `${base}-padded.png`;
    return new File([blob], paddedName, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function MenuDropdown({
  open,
  onClose,
  button,
  children,
}: {
  open: boolean;
  onClose: () => void;
  button: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [menuWidth, setMenuWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const measure = () => {
      const width = triggerRef.current?.getBoundingClientRect().width;
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) setMenuWidth(width);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={rootRef} className="relative">
      <div ref={triggerRef} className="inline-flex">
        {button}
      </div>
      {open && (
        <div
          className="absolute left-0 top-full mt-2 z-20 rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10 overflow-hidden"
          style={{ width: menuWidth ?? undefined }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ToolbarDropdownButton({
  label,
  icon: Icon,
  isOpen,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  isOpen: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      disabled={disabled}
      className={clsx(
        TOOLBAR_PILL_BTN,
        isOpen ? 'border-purple-300 bg-purple-50' : '',
        className
      )}
    >
      <span className="flex flex-row items-center w-full justify-between min-w-0">
        <span className="flex flex-row items-center gap-2 min-w-0">
          <Icon className="w-5 h-5 text-slate-600 shrink-0 block" />
          <span className="truncate leading-none">{label}</span>
        </span>
        <ChevronDown className="w-5 h-5 text-slate-500 shrink-0 block" />
      </span>
    </button>
  );
}

export function AIImageGenerator({ onGenerate }: AIImageGeneratorProps) {
  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const ensurePngDataUrl = async (src: string) => {
    if (!src) throw new Error('Missing image source.');
    if (/^data:image\/png;base64,/i.test(src.trim())) return src.trim();

    const res = src.startsWith('/api/') ? await authFetch(src) : await fetch(src);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load image for saving.');
    }
    const blob = await res.blob();
    if (blob.type && blob.type !== 'image/png') {
      throw new Error('Only PNG images can be saved to My Designs.');
    }
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    return `data:image/png;base64,${base64}`;
  };

  const ensureTrimmedPngDataUrl = async (src: string) => {
    if (!src) throw new Error('Missing image source.');

    const trimmedSrc = src.trim();
    const isDataUrl = /^data:image\//i.test(trimmedSrc);

    let objectUrlToRevoke: string | null = null;
    try {
      let img: HTMLImageElement;
      if (isDataUrl) {
        img = await loadImageElement(trimmedSrc);
      } else {
        const res = trimmedSrc.startsWith('/api/') ? await authFetch(trimmedSrc) : await fetch(trimmedSrc);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load image for cropping.');
        }
        const blob = await res.blob();
        objectUrlToRevoke = URL.createObjectURL(blob);
        img = await loadImageElement(objectUrlToRevoke);
      }

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error('Invalid image dimensions.');

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas not supported.');

      // Force a white background so previews/downloads never show gray/transparent backgrounds.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, width, height);

      // Normalize light neutral backgrounds to pure white.
      normalizeCanvasBackgroundToWhite(canvas);

      // Loose crop: remove excess whitespace but keep the full subject safely in frame.
      const croppedCanvas = cropCanvasLoose(canvas, 0.25);

      // Ensure final export is solid white background PNG.
      const out = document.createElement('canvas');
      out.width = croppedCanvas.width;
      out.height = croppedCanvas.height;
      const outCtx = out.getContext('2d', { willReadFrequently: true });
      if (!outCtx) throw new Error('Canvas not supported.');
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, out.width, out.height);
      outCtx.drawImage(croppedCanvas, 0, 0);

      return out.toDataURL('image/png');
    } finally {
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    }
  };

  const exportScale = 1 as const;
  const setExportScale = (_value: unknown) => { };

  const ensureWhiteBackgroundPngDataUrl = async (src: string) => {
    if (!src) throw new Error('Missing image source.');

    const trimmedSrc = src.trim();
    const isDataUrl = /^data:image\//i.test(trimmedSrc);

    let objectUrlToRevoke: string | null = null;
    try {
      let img: HTMLImageElement;
      if (isDataUrl) {
        img = await loadImageElement(trimmedSrc);
      } else {
        const res = trimmedSrc.startsWith('/api/') ? await authFetch(trimmedSrc) : await fetch(trimmedSrc);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load image for processing.');
        }
        const blob = await res.blob();
        objectUrlToRevoke = URL.createObjectURL(blob);
        img = await loadImageElement(objectUrlToRevoke);
      }

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error('Invalid image dimensions.');

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas not supported.');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, width, height);
      normalizeCanvasBackgroundToWhite(canvas);

      return canvas.toDataURL('image/png');
    } finally {
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    }
  };

  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<ArtStyleKey>('3d');
  const [resolution, setResolution] = useState<number>(1024);
  const [selectedViews, setSelectedViews] = useState<ViewKey[]>(['front']);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [styleProgress, setStyleProgress] = useState<Record<string, 'pending' | 'converting' | 'done' | 'error'>>({});
  const [lastStyleTarget, setLastStyleTarget] = useState<ArtStyleKey | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [editedImageDataUrl, setEditedImageDataUrl] = useState<string | null>(null);
  const [editedViews, setEditedViews] = useState<
    Array<{ view: ViewKey; style?: string; imageDataUrl?: string; error?: string }> | null
  >(null);
  const [uploadedImageDataUrl, setUploadedImageDataUrl] = useState<string | null>(null);
  const [uploadedImageName, setUploadedImageName] = useState<string | null>(null);
  const [uploadedImageFile, setUploadedImageFile] = useState<File | null>(null);
  const [selectedModel, setSelectedModel] = useState<MannequinModelKey>('male');
  const [savedDesignId, setSavedDesignId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savedDesignIds, setSavedDesignIds] = useState<string[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [designName, setDesignName] = useState('');
  const [hasResultFlag, setHasResultFlag] = useState(false);
  const [openMenu, setOpenMenu] = useState<'convertStyle' | 'convertModel' | 'resolution' | 'style' | 'views' | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingResolutionClearRef = useRef(false);

  useEffect(() => {
    setUserId(getUserId());
  }, []);

  useEffect(() => {
    // Clear old results whenever the user changes resolution so we never mix sizes.
    // IMPORTANT: do NOT clear when generation finishes (isGenerating -> false), only when resolution changes.
    if (isGenerating) {
      pendingResolutionClearRef.current = true;
      return;
    }

    pendingResolutionClearRef.current = false;
    setResult(null);
    setVariants([]);
    setHasResultFlag(false);
    setEditedImageDataUrl(null);
    setEditedViews(null);
    setStatusMessage('');
    setError(null);
  }, [resolution]);

  useEffect(() => {
    if (!isGenerating && pendingResolutionClearRef.current) {
      pendingResolutionClearRef.current = false;
      setResult(null);
      setVariants([]);
      setHasResultFlag(false);
      setEditedImageDataUrl(null);
      setEditedViews(null);
      setStatusMessage('');
      setError(null);
    }
  }, [isGenerating]);

  const hasResult =
    Boolean(editedImageDataUrl) ||
    hasResultFlag ||
    variants.length > 0;
  const hasEditedViews = Boolean(editedViews?.length);
  const hasAnyResult = hasEditedViews || hasResult;
  const editedPrimaryImage = useMemo(() => {
    const fromViews = editedViews?.find((r) => typeof r.imageDataUrl === 'string' && r.imageDataUrl)?.imageDataUrl ?? null;
    return fromViews || editedImageDataUrl;
  }, [editedImageDataUrl, editedViews]);
  const previewCompact = Boolean(uploadedImageDataUrl) && (hasEditedViews || Boolean(editedImageDataUrl));

  const selectedViewsLabel = 'View Angles';
  const effectiveStyle: ArtStyleKey = selectedStyle ?? 'realistic';
  const styleButtonLabel = useMemo(() => {
    const label = styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? effectiveStyle;
    return `Style: ${label}`;
  }, [effectiveStyle]);
  const hasReferenceImage = Boolean(uploadedImageDataUrl || uploadedImageFile);
  const hasSingleEditResult = false;
  const baseVariant = useMemo(() => variants.find((v) => v.kind === 'base') ?? null, [variants]);
  const globalResolutionValue = useMemo(() => `${resolution}×${resolution}`, [resolution]);

  useEffect(() => {
    setSelectedViews((prev) => normalizeViews(prev));
  }, []);

  const toggleView = (viewId: ViewKey) => {
    setSelectedViews((prev) => {
      const next = prev.includes(viewId) ? prev.filter((id) => id !== viewId) : [...prev, viewId];
      return normalizeViews(next);
    });
  };

  const clearUploadedImage = () => {
    setUploadedImageDataUrl(null);
    setUploadedImageName(null);
    setUploadedImageFile(null);
    setEditedImageDataUrl(null);
    setEditedViews(null);
    setResult(null);
    setVariants([]);
    setHasResultFlag(false);
    setStatusMessage('');
    setError(null);
    if (uploadInputRef.current) uploadInputRef.current.value = '';
  };

  const handleUploadImage = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;

    if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) {
      setError('Please upload a PNG, JPG, or WEBP image.');
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`File too large (max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB).`);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      return;
    }

    setError(null);
    const dataUrl = await readFileAsDataUrl(file);

    if (!dataUrl.startsWith('data:image/')) {
      setError('Invalid image file.');
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      return;
    }

    setUploadedImageDataUrl(dataUrl);
    setUploadedImageName(file.name);
    setUploadedImageFile(file);
    setEditedImageDataUrl(null);
    setEditedViews(null);
    setResult(null);
    setHasResultFlag(false);
    setStatusMessage('');
  };
  const handleGenerate = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError('Please enter a prompt.');
      return;
    }
    const templated = applyCategoryTemplate(trimmedPrompt);
    const safePrompt = applyBrandSafety(templated.prompt);
    console.info('[ai] category', templated.category);
    console.log('User selected resolution:', resolution);
    const shouldForceWhiteBackground = !promptRequestsNonWhiteBackgroundClient(trimmedPrompt);

    const variationPhrases = [
      'slightly different fabric wrinkles and folds',
      'slightly different lighting balance while keeping pure white background',
      'slightly different camera distance while keeping full product visible',
      'slightly different material texture details',
      'slightly different highlights and shadows on the product (no background shadows)',
    ];
    const variation = variationPhrases[Math.floor(Math.random() * variationPhrases.length)] ?? 'slightly different details';
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random()}`;
    const finalPrompt = appendPromptModifier(safePrompt, `Variation: ${variation}. RequestId: ${requestId}.`);

    const normalizedViews = normalizeViews(selectedViews);
    if (!normalizedViews.length) {
      setError('Please select at least one view.');
      return;
    }

    const referenceMatch = uploadedImageDataUrl ? /^data:([^;]+);base64,(.+)$/i.exec(uploadedImageDataUrl) : null;
    const referenceImageBase64 = referenceMatch?.[2] ?? null;
    const referenceImageMimeType = referenceMatch?.[1] ?? (uploadedImageFile?.type || null);

    setIsGenerating(true);
    setStatusMessage('Generating base design (front view)...');
    setError(null);
    setStyleProgress({});
    setLastStyleTarget(null);
    setSaveMessage(null);
    setSaveError(null);
    setSavedDesignId(null);
    setSavedDesignIds([]);
    setDesignName('');
    setEditedImageDataUrl(null);
    setEditedViews(null);
    setResult(null);
    setVariants([]);
    setHasResultFlag(false);

    try {
      const baseResp = await authFetch('/api/generate-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          style: effectiveStyle,
          resolution,
          width: resolution,
          height: resolution,
          ...(referenceImageBase64 ? { referenceImageBase64, referenceImageMimeType } : {}),
        }),
      });
      const basePayload = await baseResp.json().catch(() => ({}));
      if (!baseResp.ok) throw new Error(basePayload.error || 'Base generation failed.');
      if (!basePayload?.baseImage) throw new Error('Base generation failed.');

      setStatusMessage('Generating requested views from the base design...');
      const viewsResp = await authFetch('/api/generate-views-from-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseImageBase64: basePayload.baseImage,
          views: normalizedViews,
          style: effectiveStyle,
          resolution,
          width: resolution,
          height: resolution,
          prompt: finalPrompt,
        }),
      });
      const viewsPayload = await viewsResp.json().catch(() => ({}));
      if (!viewsResp.ok) throw new Error(viewsPayload.error || 'View generation failed.');
      if (!viewsPayload?.compositeBase64 || !Array.isArray(viewsPayload.images)) throw new Error('View generation failed.');

      const viewToBase64 = new Map<ViewKey, string>();
      for (const it of viewsPayload.images as Array<{ view: ViewKey; imageBase64: string }>) {
        if (it?.view && it?.imageBase64) viewToBase64.set(it.view, it.imageBase64);
      }

      const orderedImages: GeneratedImage[] = normalizedViews.map((view) => {
        const imageBase64 = viewToBase64.get(view);
        if (!imageBase64) throw new Error(`Missing generated view: ${view}`);
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64, width: resolution, height: resolution };
      });

      setStatusMessage(shouldForceWhiteBackground ? 'Fitting images to frame...' : 'Preparing images...');
      const croppedImages: GeneratedImage[] = await Promise.all(
        orderedImages.map(async (img) => {
          const fittedSrc = shouldForceWhiteBackground ? await fitImageToFrame(img.src, resolution, 0.01) : img.src;
          const fixedSrc = await ensurePngDataUrlSquareSize(fittedSrc, resolution);
          return {
            ...img,
            src: fixedSrc,
            imageBase64: stripPngDataUrl(fixedSrc) || img.imageBase64,
            width: resolution,
            height: resolution,
          };
        })
      );

      const composite = `data:image/png;base64,${String(viewsPayload.compositeBase64)}`;
      const baseVariant: GeneratedVariant = {
        id: crypto.randomUUID(),
        kind: 'base',
        styleLabel: styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? String(effectiveStyle),
        styleKey: effectiveStyle,
        views: normalizedViews,
        composite,
        images: croppedImages,
      };

      setVariants([baseVariant]);
      setHasResultFlag(true);
      setStatusMessage('Generated views successfully.');
      onGenerate?.(composite);

      void Promise.all(
        croppedImages.map(async (img) => {
          try {
            const { width, height } = await getImageSize(img.src);
            if (width !== resolution || height !== resolution) {
              console.warn('[AIImageGenerator] View size mismatch after generation:', {
                view: img.view,
                expected: `${resolution}x${resolution}`,
                actual: `${width}x${height}`,
              });
            }
          } catch {
            // ignore
          }
        })
      );
    } catch (err: any) {
      setError(err?.message || 'Something went wrong while generating images.');
      setResult(null);
      setVariants([]);
      setEditedImageDataUrl(null);
      setEditedViews(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConvertStyle = async (target: ArtStyleKey) => {
    const base = variants.find((v) => v.kind === 'base') ?? null;
    if (!base) return;

    setIsGenerating(true);
    setLastStyleTarget(target);
    setStatusMessage(`Converting style to ${styleOptions.find((opt) => opt.id === target)?.label ?? target}...`);
    setError(null);
    setStyleProgress(Object.fromEntries(base.views.map((v) => [v, 'pending' as const])));

    try {
      const viewToBase64 = new Map<ViewKey, string>();
      const viewToInput = new Map<ViewKey, string>();
      for (const img of base.images) {
        viewToInput.set(img.view, img.imageBase64 ?? '');
      }

      for (let i = 0; i < base.views.length; i += 1) {
        const view = base.views[i];
        const viewKey = view;
        setStyleProgress((prev) => ({ ...prev, [viewKey]: 'converting' }));
        setStatusMessage(
          `Converting style to ${styleOptions.find((opt) => opt.id === target)?.label ?? target} (${i + 1}/${base.views.length
          })...`
        );

        const inputBase64 = viewToInput.get(view) ?? '';
        const resp = await authFetch('/api/convert-style', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images: [{ view: viewKey, imageBase64: inputBase64 }],
            styleKey: target,
          }),
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setStyleProgress((prev) => ({ ...prev, [viewKey]: 'error' }));
          throw new Error(payload.error || `Style conversion failed for ${viewKey}.`);
        }
        if (!Array.isArray(payload.converted) || !payload.converted[0]?.imageBase64) {
          setStyleProgress((prev) => ({ ...prev, [viewKey]: 'error' }));
          throw new Error(`Style conversion failed for ${viewKey}.`);
        }

        viewToBase64.set(view, String(payload.converted[0].imageBase64));
        setStyleProgress((prev) => ({ ...prev, [viewKey]: 'done' }));
      }

      const orderedImages: GeneratedImage[] = base.views.map((view) => {
        const imageBase64 = viewToBase64.get(view);
        if (!imageBase64) throw new Error(`Missing converted view: ${view}`);
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64, width: resolution, height: resolution };
      });

      const composite = await composeCompositeFromTiles(orderedImages, resolution);
      const styleVariant: GeneratedVariant = {
        id: crypto.randomUUID(),
        kind: 'style_converted',
        styleLabel: styleOptions.find((opt) => opt.id === target)?.label ?? String(target),
        styleKey: target,
        views: base.views,
        composite,
        images: await Promise.all(
          orderedImages.map(async (img) => {
            const fittedSrc = await fitImageToFrame(img.src, resolution, 0.01);
            const fixedSrc = await ensurePngDataUrlSquareSize(fittedSrc, resolution);
            return {
              ...img,
              src: fixedSrc,
              imageBase64: stripPngDataUrl(fixedSrc) || img.imageBase64,
              width: resolution,
              height: resolution,
            };
          })
        ),
      };

      setVariants((prev) => {
        const keep = prev.filter((v) => v.kind !== 'style_converted' && v.kind !== 'model_preview');
        return [...keep, styleVariant];
      });
      setStatusMessage('Style converted.');
    } catch (err: any) {
      setError(err?.message || 'Style conversion failed.');
      setStatusMessage('Style conversion failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConvertModel = async (modelKey: MannequinModelKey) => {
    const base = variants.find((v) => v.kind === 'base') ?? null;
    if (!base) return;

    const modelSourceImages = base.images.filter((img) => img.view === 'front' || img.view === 'back');
    if (!modelSourceImages.length) {
      setError('Missing base front/back views for model conversion.');
      return;
    }

    setIsGenerating(true);
    setStatusMessage(`Generating ${modelKey} mannequin previews...`);
    setError(null);

    try {
      const resp = await authFetch('/api/convert-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: modelSourceImages.map((img) => ({ view: img.view, imageBase64: img.imageBase64 ?? '' })),
          modelKey,
          // Model previews should always be generated as realistic photography (not 3D/CGI),
          // regardless of the selected generation style.
          style: 'realistic',
        }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || 'Model conversion failed.');
      if (!Array.isArray(payload.converted)) throw new Error('Model conversion failed.');

      const viewToBase64 = new Map<ViewKey, string>();
      for (const it of payload.converted as Array<{ view: ViewKey; imageBase64: string }>) {
        if (it?.view && it?.imageBase64) viewToBase64.set(it.view, it.imageBase64);
      }

      const orderedImages: GeneratedImage[] = modelSourceImages.map((img) => img.view).map((view) => {
        const imageBase64 = viewToBase64.get(view);
        if (!imageBase64) throw new Error(`Missing model preview view: ${view}`);
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64, width: resolution, height: resolution };
      });

      const composite = await composeCompositeFromTiles(orderedImages, resolution);
      const modelVariant: GeneratedVariant = {
        id: crypto.randomUUID(),
        kind: 'model_preview',
        styleLabel: 'Realistic',
        styleKey: 'realistic',
        modelLabel: modelKey === 'male' ? 'Male' : 'Female',
        modelKey,
        views: orderedImages.map((i) => i.view),
        composite,
        images: await Promise.all(
          orderedImages.map(async (img) => {
            const fittedSrc = await fitImageToFrame(img.src, resolution, 0.01);
            const fixedSrc = await ensurePngDataUrlSquareSize(fittedSrc, resolution);
            return {
              ...img,
              src: fixedSrc,
              imageBase64: stripPngDataUrl(fixedSrc) || img.imageBase64,
              width: resolution,
              height: resolution,
            };
          })
        ),
      };

      setVariants((prev) => {
        const keep = prev.filter((v) => v.kind !== 'model_preview');
        return [...keep, modelVariant];
      });
      setStatusMessage('Model previews generated.');
    } catch (err: any) {
      setError(err?.message || 'Model conversion failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveDesign = async () => {
    const variantsToSave = variants.length
      ? variants
      : result
        ? [
          {
            id: 'single',
            styleLabel: styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? String(effectiveStyle),
            styleKey: effectiveStyle,
            views: result.images.map((i) => i.view),
            composite: result.composite,
            images: result.images,
          } as GeneratedVariant,
        ]
        : [];

    if (!variantsToSave.length) return;
    const uid = userId || getUserId();
    const finalName = designName.trim();
    if (!finalName) {
      setSaveError('Please enter a design name before saving.');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      setStatusMessage('Preparing PNGs for saving...');
      const savedIds: string[] = [];

      for (const variant of variantsToSave) {
        const styleLabel = variant.styleLabel;
        const modelLabel = variant.modelLabel ?? '';
        const suffix =
          variantsToSave.length > 1 ? ` - ${[modelLabel, styleLabel].filter(Boolean).join(' - ')}` : '';
        const nameWithSuffix = `${finalName}${suffix}`.slice(0, 60);

        const viewsToSave = (variant.images || []).map((img) => img.view);
        const imageDataUrls = await Promise.all(variant.images.map((img) => ensureTrimmedPngDataUrl(img.src)));

        const payload = {
          name: nameWithSuffix,
          title: nameWithSuffix,
          prompt: prompt.trim(),
          userId: uid,
          style: variant.styleKey ?? effectiveStyle,
          resolution,
          views: viewsToSave,
          images: variant.images.map((img, idx) => ({ view: img.view, dataUrl: imageDataUrls[idx] })),
        };

        const response = await authFetch('/api/designs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to save design.');
        }

        const data = await response.json();
        if (data?.id) savedIds.push(String(data.id));
      }

      setSavedDesignId(savedIds[0] ?? null);
      setSavedDesignIds(savedIds);
      setSaveMessage(`Saved ${savedIds.length} design${savedIds.length === 1 ? '' : 's'} to My Designs.`);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save design.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadAll = async () => {
    const baseVariant =
      variants.find((v) => v.kind === 'base') ??
      (result
        ? ({
          id: 'single',
          kind: 'base',
          styleLabel: styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? String(effectiveStyle),
          styleKey: effectiveStyle,
          views: result.images.map((i) => i.view),
          composite: result.composite,
          images: result.images,
        } as GeneratedVariant)
        : null);

    if (!baseVariant) return;

    const styleVariant = variants.find((v) => v.kind === 'style_converted') ?? null;
    const modelVariant = variants.find((v) => v.kind === 'model_preview') ?? null;

    const buildItems = (folder: string, v: GeneratedVariant) =>
      v.images.map((img) => ({
        name: `${folder}/${img.view}.png`,
        imageBase64: img.imageBase64 ?? stripPngDataUrl(img.src),
      }));

    const items = [
      ...buildItems('base', baseVariant),
      ...(styleVariant ? buildItems('style_converted', styleVariant) : []),
      ...(modelVariant ? buildItems('model_preview', modelVariant) : []),
    ].filter((it) => it.imageBase64);

    if (!items.length) return;

    setIsGenerating(true);
    setStatusMessage(exportScale > 1 ? `Preparing ${exportScale}× export...` : 'Preparing ZIP export...');
    setError(null);

    try {
      const finalItems =
        exportScale > 1
          ? await Promise.all(
            items.map(async (it) => {
              const dataUrl = `data:image/png;base64,${it.imageBase64}`;
              const blob = await exportImageAtScale(dataUrl, exportScale);
              const scaledDataUrl = await blobToDataUrl(blob);
              return { ...it, imageBase64: stripPngDataUrl(scaledDataUrl) };
            })
          )
          : items;

      const resp = await authFetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'zip', items: finalItems }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || 'Export failed.');
      if (!payload?.url) throw new Error('Export failed.');
      const resolved = resolveApiAssetUrl(String(payload.url));
      const url = new URL(resolved, window.location.origin);
      if (!url.searchParams.get('uid')) url.searchParams.set('uid', getUserId());
      window.location.href = url.toString();
      setStatusMessage('Export started.');
    } catch (err: any) {
      setError(err?.message || 'Export failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
	          <div className="app-shimmer-sweep w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
	            <Sparkles className="w-5 h-5 text-white" />
	          </div>
          <div>
            <h2 className="text-slate-900">AI Image Generator</h2>
            <p className="text-slate-600 text-sm">
              Generate one base design, then generate consistent multi-view outputs.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-8 space-y-8">
          <div>
            <label className="block text-sm text-slate-700 mb-2">Describe what you want</label>
            <div className="relative">
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  handleUploadImage(e.target.files).catch((err) => setError(err?.message || 'Failed to read image.'));
                }}
              />
              <div className="absolute bottom-3 left-3 z-10 flex items-center">
                <button
                  type="button"
                  onClick={() => {
                    if (uploadInputRef.current) uploadInputRef.current.value = '';
                    uploadInputRef.current?.click();
                  }}
                  className={TOOLBAR_ICON_BTN}
                  aria-label={hasReferenceImage ? 'Replace reference image' : 'Upload reference image'}
                  title={hasReferenceImage ? 'Replace reference image' : 'Upload reference image'}
                >
                  <Plus className="w-6 h-6" />
                </button>

                {hasReferenceImage && (
                  <div className="ml-2 px-3 py-1 rounded-full border border-slate-200 bg-slate-50 flex items-center gap-2 text-sm max-w-[200px] min-w-0">
                    <span className="text-slate-800 truncate min-w-0">
                      {uploadedImageFile?.name || uploadedImageName || 'Uploaded image'}
                    </span>
                    <button
                      type="button"
                      onClick={clearUploadedImage}
                      className="text-slate-600 hover:text-red-500 flex-none"
                      aria-label="Remove uploaded image"
                      title="Remove"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g., A futuristic streetwear hoodie design with cyberpunk aesthetics, neon colors, and geometric patterns..."
                className="w-full h-32 px-4 py-3 pr-12 pl-14 pb-14 rounded-2xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none resize-none transition-colors"
              />
              <Wand2 className="absolute right-4 top-4 w-5 h-5 text-slate-400" />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <MenuDropdown
                open={openMenu === 'resolution'}
                onClose={() => setOpenMenu(null)}
                button={
                  <ToolbarDropdownButton
                    label="Resolution"
                    icon={Maximize2}
                    isOpen={openMenu === 'resolution'}
                    onClick={() => setOpenMenu((prev) => (prev === 'resolution' ? null : 'resolution'))}
                    className="max-w-[190px]"
                  />
                }
              >
                <div className="p-1.5">
                  <div className="flex flex-col gap-2">
                    {resolutionOptions.map((res) => {
                      const active = resolution === res;
                      return (
                        <button
                          key={res}
                          type="button"
                          onClick={() => {
                            setResolution(res);
                            setOpenMenu(null);
                          }}
                          className={clsx(
                            'w-full h-[48px] px-3 rounded-xl text-sm border-2 text-left transition-all flex items-center justify-between gap-3',
                            active
                              ? 'bg-purple-50 text-slate-900 border-purple-300 shadow-sm'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-purple-300 hover:bg-slate-50'
                          )}
                        >
                          <span className="truncate">{formatResolution(res)}</span>
                          {active && <Check className="w-4 h-4 text-purple-600 flex-none" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </MenuDropdown>

              <MenuDropdown
                open={openMenu === 'style'}
                onClose={() => setOpenMenu(null)}
                button={
                  <ToolbarDropdownButton
                    label={styleButtonLabel}
                    icon={Palette}
                    isOpen={openMenu === 'style'}
                    onClick={() => setOpenMenu((prev) => (prev === 'style' ? null : 'style'))}
                    className="max-w-[170px]"
                  />
                }
              >
                <div className="p-1.5">
                  <div className="px-2 pt-2 pb-1">
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
                        {styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? effectiveStyle}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 p-2">
                    {styleOptions.map((opt) => {
                      const active = effectiveStyle === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setSelectedStyle(opt.id);
                            setOpenMenu(null);
                          }}
                          className={clsx(
                            'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border transition-all text-left',
                            active
                              ? 'bg-purple-50 text-slate-900 border-purple-300'
                              : 'bg-white text-slate-800 border-slate-200 hover:border-purple-300 hover:bg-slate-50'
                          )}
                        >
                          <span className="min-w-0 text-sm truncate">{opt.label}</span>
                          {active && <Check className="w-4 h-4 text-purple-600 flex-none" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </MenuDropdown>

              <MenuDropdown
                open={openMenu === 'views'}
                onClose={() => setOpenMenu(null)}
                button={
                  <ToolbarDropdownButton
                    label={selectedViewsLabel}
                    icon={Camera}
                    isOpen={openMenu === 'views'}
                    onClick={() => setOpenMenu((prev) => (prev === 'views' ? null : 'views'))}
                    className="max-w-[220px]"
                  />
                }
              >
                <div className="p-1.5">
                  <div className="space-y-1">
                    {viewOptions.map((view) => {
                      const active = selectedViews.includes(view.id);
                      return (
                        <button
                          key={view.id}
                          type="button"
                          onClick={() => toggleView(view.id)}
                          className={clsx(
                            'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border transition-colors text-left',
                            active
                              ? 'bg-purple-50 text-slate-900 border-purple-300'
                              : 'bg-white text-slate-800 border-transparent hover:bg-slate-50'
                          )}
                        >
                          <span className="min-w-0 text-sm truncate">{view.label}</span>
                          {active && <Check className="w-4 h-4 text-purple-600 flex-none shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </MenuDropdown>

              <MenuDropdown
                open={openMenu === 'convertStyle'}
                onClose={() => setOpenMenu(null)}
                button={
                  <ToolbarDropdownButton
                    label="Convert Style"
                    icon={Palette}
                    isOpen={openMenu === 'convertStyle'}
                    disabled={isGenerating || !variants.some((v) => v.kind === 'base')}
                    onClick={() => setOpenMenu((prev) => (prev === 'convertStyle' ? null : 'convertStyle'))}
                    className="max-w-[160px]"
                  />
                }
              >
                <div className="p-1.5">
                  <div className="flex flex-col gap-2">
                    {styleOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          handleConvertStyle(opt.id);
                        }}
                        className="w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border transition-all text-left bg-white text-slate-800 border-slate-200 hover:border-purple-300 hover:bg-slate-50"
                      >
                        <span className="min-w-0 text-sm truncate">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </MenuDropdown>

              <MenuDropdown
                open={openMenu === 'convertModel'}
                onClose={() => setOpenMenu(null)}
                button={
                  <ToolbarDropdownButton
                    label="Convert Model"
                    icon={Users}
                    isOpen={openMenu === 'convertModel'}
                    disabled={isGenerating || !variants.some((v) => v.kind === 'base')}
                    onClick={() => setOpenMenu((prev) => (prev === 'convertModel' ? null : 'convertModel'))}
                    className="max-w-[170px]"
                  />
                }
              >
                <div className="p-1.5">
                  <div className="flex flex-col gap-2">
                    {(['male', 'female'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setSelectedModel(m);
                          setOpenMenu(null);
                          handleConvertModel(m);
                        }}
                        className="w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border transition-all text-left bg-white text-slate-800 border-slate-200 hover:border-purple-300 hover:bg-slate-50"
                      >
                        <span className="min-w-0 text-sm truncate">{m === 'male' ? 'Male' : 'Female'}</span>
                      </button>
                    ))}
                  </div>
                </div>
	              </MenuDropdown>

		              <button
		                onClick={handleGenerate}
		                disabled={isGenerating || prompt.trim().length === 0}
	                className="aiig-shimmer ml-auto bg-gradient-to-r from-violet-500 to-purple-500 text-white inline-flex h-14 min-w-[190px] items-center rounded-full px-14 text-[15px] font-medium leading-none whitespace-nowrap shadow-sm transition-all hover:shadow hover:shadow-purple-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-200 disabled:opacity-60 disabled:cursor-not-allowed"
	              >
		                {isGenerating ? (
		                  <span className="flex items-center gap-2 whitespace-nowrap">
		                    <Loader2 className="w-5 h-5 animate-spin shrink-0 self-center" />
		                    <span className="whitespace-nowrap self-center">Generating...</span>
		                  </span>
		                ) : (
		                  <span className="flex items-center gap-2 whitespace-nowrap">
		                    <Sparkles className="w-5 h-5 shrink-0 self-center" />
		                    <span className="whitespace-nowrap self-center">Generate Image</span>
		                  </span>
		                )}
		              </button>


	            </div>

            {/* helper text removed */}
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
              {lastStyleTarget && (
                <button
                  type="button"
                  className="ml-auto inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs hover:bg-purple-700"
                  onClick={() => handleConvertStyle(lastStyleTarget)}
                  disabled={isGenerating}
                >
                  Retry conversion
                </button>
              )}
            </div>
          )}

          {baseVariant?.views?.length && Object.keys(styleProgress).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {baseVariant.views.map((v) => {
                const key = v;
                const st = styleProgress[key];
                const label = viewLabel(v);
                return (
                  <div
                    key={key}
                    className={clsx(
                      'rounded-lg border px-3 py-2 flex items-center justify-between',
                      st === 'done'
                        ? 'border-green-200 bg-green-50 text-green-800'
                        : st === 'error'
                          ? 'border-red-200 bg-red-50 text-red-800'
                          : st === 'converting'
                            ? 'border-purple-200 bg-purple-50 text-purple-800'
                            : 'border-slate-200 bg-slate-50 text-slate-700'
                    )}
                  >
                    <span className="truncate">{label}</span>
                    <span className="ml-2">
                      {st === 'done' ? 'Done' : st === 'error' ? 'Error' : st === 'converting' ? '...' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

	          <style>{`
	            @keyframes aiig-shine {
	              0% {
	                transform: translate3d(-140%, 0, 0) skewX(-18deg);
	              }
	              100% {
	                transform: translate3d(240%, 0, 0) skewX(-18deg);
	              }
	            }
            .aiig-shimmer {
              position: relative;
              overflow: hidden;
            }
	            .aiig-shimmer::after {
	              content: '';
	              position: absolute;
	              inset: -60% -40%;
	              width: 55%;
	              left: -60%;
	              background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.85), transparent);
	              transform: translate3d(-140%, 0, 0) skewX(-18deg);
	              opacity: 1;
	              pointer-events: none;
	              will-change: transform;
	              animation: aiig-shine 4s linear infinite;
	            }
	            @media (prefers-reduced-motion: reduce) {
	              .aiig-shimmer::after { animation-duration: 8s; }
	            }
	          `}</style>

          {statusMessage && !isGenerating && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-2 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              {statusMessage}
            </p>
          )}

          <ListingAssistantInline onUseAsPrompt={(val) => setPrompt(val)} />
        </div>

        {hasAnyResult && (
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
            <div className="w-full">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    {hasEditedViews || hasSingleEditResult ? 'Edited Preview' : 'Preview'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {hasEditedViews || hasSingleEditResult
                      ? `Edited from upload · ${globalResolutionValue}`
                      : `${resolution}×${resolution}`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="hidden sm:flex flex-col items-end">
                    <label className="text-[11px] text-slate-500 leading-none">Export</label>
                    <select
                      className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800"
                      value={exportScale}
                      onChange={(e) => setExportScale(Number(e.target.value) as any)}
                    >
                      <option value={1}>Normal (1×)</option>
                      <option value={2}>HD (2×)</option>
                      <option value={4}>4K (4×)</option>
                      <option value={8}>8K (8×)</option>
                    </select>
                  </div>

                  <button
                    onClick={() => {
                      if (hasEditedViews) {
                        if (!editedViews?.length) return;
                        void (async () => {
                          try {
                            for (const item of editedViews) {
                              if (!item.imageDataUrl) return;
                              const styleSuffix = item.style ? `-${String(item.style).trim()}` : '';
                              await downloadPng(item.imageDataUrl, `${item.view}${styleSuffix}.png`, exportScale);
                            }
                          } catch (err: any) {
                            setError(err?.message || 'Download failed.');
                          }
                        })();
                        return;
                      }

                      if (editedPrimaryImage) {
                        void downloadPng(editedPrimaryImage, 'edited.png', exportScale).catch((err: any) =>
                          setError(err?.message || 'Download failed.')
                        );
                        return;
                      }

                      handleDownloadAll();
                    }}
                    className="w-9 h-9 rounded-lg border border-slate-200 hover:bg-slate-100 flex items-center justify-center"
                    title="Download"
                  >
                    <ArrowDownToLine className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-10 w-full">
                {hasEditedViews || hasSingleEditResult ? (
                  editedPrimaryImage ? (
                    <ViewItem
                      label="Edited Preview"
                      url={editedPrimaryImage}
                      resolution={resolution}
                      onDownload={() => {
                        void downloadPng(editedPrimaryImage, 'edited.png', exportScale).catch((err: any) =>
                          setError(err?.message || 'Download failed.')
                        );
                      }}
                    />
                  ) : null
                ) : variants.length > 1 ? (
                  variants.map((variant) => {
                    const suffix =
                      variant.kind === 'style_converted'
                        ? String(variant.styleKey ?? variant.styleLabel).trim().replace(/\s+/g, '-')
                        : variant.kind === 'model_preview'
                          ? String(variant.modelKey ?? variant.modelLabel ?? 'model').trim().replace(/\s+/g, '-')
                          : '';

                    return (
                      <div key={variant.id} className="w-full flex flex-col gap-6 items-center">
                        <div
                          className="w-full flex flex-wrap items-center justify-between gap-2"
                          style={{ maxWidth: resolution }}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            {variant.modelLabel && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
                                Model: {variant.modelLabel}
                              </span>
                            )}
                            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
                              Style: {variant.styleLabel}
                            </span>
                          </div>
                        </div>

                        <div className="w-full flex flex-col gap-10">
                          {variant.views.map((view) => {
                            const image = variant.images.find((img) => img.view === view) ?? null;
                            if (!image) {
                              return (
                                <div key={`${variant.id}-${view}`} className="w-full flex flex-col gap-2 items-center">
                                  <div className="w-full flex items-center justify-between gap-3" style={{ maxWidth: resolution }}>
                                    <h3 className="text-sm font-medium text-slate-900">{viewLabel(view)}</h3>
                                  </div>
                                  <div className="w-full text-sm text-slate-600" style={{ maxWidth: resolution }}>
                                    Missing view.
                                  </div>
                                </div>
                              );
                            }

                            if (!isProbablyValidPngDataUrl(image.src)) {
                              return (
                                <div key={`${variant.id}-${view}`} className="w-full flex flex-col gap-2 items-center">
                                  <div className="w-full flex items-center justify-between gap-3" style={{ maxWidth: resolution }}>
                                    <h3 className="text-sm font-medium text-slate-900">{viewLabel(view)}</h3>
                                    {variant.kind === 'style_converted' && variant.styleKey && (
                                      <button
                                        type="button"
                                        className="text-purple-600 text-xs hover:underline"
                                        onClick={() => handleConvertStyle(variant.styleKey as ArtStyleKey)}
                                      >
                                        Retry conversion
                                      </button>
                                    )}
                                  </div>
                                  <div className="w-full text-sm text-slate-600" style={{ maxWidth: resolution }}>
                                    Invalid image.
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <ViewItem
                                key={`${variant.id}-${view}`}
                                label={viewLabel(view)}
                                url={image.src}
                                resolution={image.width ?? resolution}
                                viewKey={view}
                                onDownload={() => {
                                  const file = suffix ? `${view}-${suffix}.png` : `${view}.png`;
                                  void downloadPng(image.src, file, exportScale).catch((err: any) =>
                                    setError(err?.message || 'Download failed.')
                                  );
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  ((variants[0]?.images ?? result?.images) ?? []).map((image) =>
                    isProbablyValidPngDataUrl(image.src) ? (
                      <ViewItem
                        key={image.view}
                        label={viewLabel(image.view)}
                        url={image.src}
                        resolution={image.width ?? resolution}
                        viewKey={image.view}
                        onDownload={() => {
                          void downloadPng(image.src, `${image.view}.png`, exportScale).catch((err: any) =>
                            setError(err?.message || 'Download failed.')
                          );
                        }}
                      />
                    ) : (
                      <div key={image.view} className="w-full flex flex-col gap-2 items-center">
                        <div className="w-full flex items-center justify-between gap-3" style={{ maxWidth: resolution }}>
                          <h3 className="text-sm font-medium text-slate-900">{viewLabel(image.view)}</h3>
                        </div>
                        <div className="w-full text-sm text-slate-600" style={{ maxWidth: resolution }}>
                          Invalid image.
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            </div>

            {editedViews && (
              <div className="mt-6">
                <p className="text-slate-900 font-medium mb-3">Edited Views</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-start justify-items-center">
                  {editedViews.map((item) => (
                    <div
                      key={`${item.view}-${item.style ?? ''}`}
                      className="w-full max-w-[420px] rounded-2xl border border-slate-200 overflow-hidden bg-white shadow-sm"
                    >
                      <div className="p-2">
                        <PreviewFrame maxHeightClassName="max-h-[320px]">
                          {item.imageDataUrl ? (
                            <PreviewImage src={item.imageDataUrl} alt={viewLabel(item.view)} view={item.view} />
                          ) : (
                            <div className="p-4 text-center">
                              <p className="text-sm text-slate-900">{viewLabel(item.view)}</p>
                              <p className="text-xs text-red-600 mt-1">{item.error || 'Failed'}</p>
                            </div>
                          )}
                        </PreviewFrame>
                      </div>
                      <div className="p-3 flex items-center justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm text-slate-900">{viewLabel(item.view)}</p>
                            {item.style && (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                                {String(item.style)}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500">Edited from upload</p>
                        </div>
                        {item.imageDataUrl && (
                          <button
                            onClick={() => {
                              const styleSuffix = item.style ? `-${String(item.style).trim()}` : '';
                              void downloadPng(item.imageDataUrl as string, `${item.view}${styleSuffix}.png`, exportScale).catch(
                                (err: any) => setError(err?.message || 'Download failed.')
                              );
                            }}
                            className="text-purple-600 text-xs hover:underline"
                          >
                            Download
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(variants.length > 0 || result) && (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
                <div className="flex-1">
                  <label className="block text-sm text-slate-700 mb-2">Design name</label>
                  <input
                    value={designName}
                    onChange={(e) => setDesignName(e.target.value)}
                    placeholder="e.g., Shirt Front/Back"
                    className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  />
                </div>
                <button
                  onClick={handleSaveDesign}
                  disabled={isSaving || !!savedDesignId || !designName.trim()}
                  className={clsx(
                    'px-5 py-3 rounded-2xl text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap md:min-w-[220px]',
                    isSaving || savedDesignId || !designName.trim()
                      ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                      : 'bg-gradient-to-r from-violet-500 to-purple-500 text-white hover:shadow-xl hover:shadow-purple-500/30'
                  )}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : savedDesignId ? (
                    <>Saved ✓</>
                  ) : (
                    <>Save to My Designs</>
                  )}
                </button>
              </div>
            )}

            {(variants.length > 0 || result) && (saveMessage || saveError) && (
              <div
                className={clsx(
                  'rounded-xl border px-4 py-3 text-sm',
                  saveMessage ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'
                )}
              >
                {saveMessage || saveError}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
