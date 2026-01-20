import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

const rootEnv = path.resolve(process.cwd(), '.env');
const serverEnv = path.resolve(process.cwd(), 'server', '.env');

if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv, override: true });
if (fs.existsSync(serverEnv)) dotenv.config({ path: serverEnv, override: true });

import cors from 'cors';
import express, { Request, Response } from 'express';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { connectMongo, getDb } from './db';
import { Design } from './models/Design';
import { VideoDesign } from './models/VideoDesign';
import {
  uploadDataUrlToGridFS,
  uploadFileToGridFS,
  downloadGridFSFile,
  deleteGridFSFile,
  getFileInfo,
  getReadStream,
  getReadStreamRange,
} from './gridfs';
import archiver from 'archiver';
import { Types } from 'mongoose';
import { createVideoJob, getJobOutputPath, getVideoJob, hasJobOutput } from './video';
import multer from 'multer';
import os from 'node:os';
import { getAssetInfo, saveUploadedAsset, startAssetCleanup } from './videoAssets';
import { buildTryOnModelViewConstraints, deriveModelFormatFromEnv, inferAspectRatio, isProductionEnv, isPromptEnhancerDebug, maybeEnhancePrompt } from './promptEnhancer/runtime';
import { assertPromptEnhancerSelectionDevOnly } from './promptEnhancer/assertions';
import { buildGenerateViewsResponse } from './handlers/generateViewsResponse';
import { buildSaveDesignPayload } from './handlers/saveDesignPayload';
import { generateImageHandler } from './handlers/generateImage';
import { safeJson } from './utils/safeJson';
import { stripKeysDeep } from './utils/stripKeysDeep';

type StyleKey = 'realistic' | '3d' | 'lineart' | 'watercolor' | 'modelMale' | 'modelFemale' | 'modelKid';
type ViewKey = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'closeUp' | 'top';
type MannequinModelKey = 'male' | 'female';
type UniformViewKey = 'front' | 'back' | 'left' | 'right';

interface GenerateRequestBody {
  prompt?: string;
  style?: StyleKey;
  views?: ViewKey[];
  resolution?: number;
  autoSave?: boolean;
  title?: string;
}

interface GenerateBaseRequestBody {
  prompt?: string;
  style?: StyleKey;
  resolution?: number;
  width?: number;
  height?: number;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
}

interface GenerateViewsFromBaseRequestBody {
  baseImageBase64?: string;
  views?: ViewKey[];
  style?: StyleKey;
  resolution?: number;
  width?: number;
  height?: number;
  prompt?: string;
}

interface GenerateUniformRequestBody {
  prompt?: string;
  resolution?: number;
}

interface ConvertStyleRequestBody {
  images?: Array<{ view: ViewKey; imageBase64: string }>;
  views?: ViewKey[];
  // Backwards compatible (legacy two-view payload)
  imageFrontBase64?: string;
  imageBackBase64?: string;
  styleKey?: string;
}

interface ConvertModelRequestBody {
  images?: Array<{ view: ViewKey; imageBase64: string }>;
  // Backwards compatible (legacy two-view payload)
  imageFrontBase64?: string;
  imageBackBase64?: string;
  modelKey?: MannequinModelKey;
  style?: string;
  // Backwards compatible (older client)
  sourceStyle?: string;
}

function sanitizeKey(v?: string) {
  return (v ?? '')
    .trim()
    .replace(/\r?\n/g, '')
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
}

function inlineDataFromAnyImageBase64(input: { base64: string; mimeType?: string }) {
  const trimmed = (input.base64 || '').trim();
  if (!trimmed) return null;

  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  if (dataUrlMatch?.[1] && dataUrlMatch?.[2]) {
    return { mimeType: String(dataUrlMatch[1]), data: String(dataUrlMatch[2]) };
  }

  const mimeType = (input.mimeType || '').trim() || 'image/png';
  return { mimeType, data: trimmed };
}

const RAW_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const GEMINI_KEY = sanitizeKey(RAW_KEY);
const loadedRootEnv = fs.existsSync(rootEnv);
const loadedServerEnv = fs.existsSync(serverEnv);

console.log('Gemini key loaded, length:', GEMINI_KEY.length);

if (!GEMINI_KEY) {
  throw new Error('GEMINI_API_KEY is missing or empty after sanitization.');
}

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

const styleModifiers: Record<StyleKey, string> = {
  realistic: 'photorealistic, natural lighting, high detail, sharp focus',
  '3d': 'high-quality 3D render, PBR materials, studio lighting, octane/cycles style',
  lineart: 'clean line art, black ink on white background, no shading, no color',
  watercolor: 'watercolor painting, paper texture, soft edges, gentle pigment blooms',
  modelMale: 'photorealistic studio photo of a male model wearing the product, fashion lookbook, natural pose',
  modelFemale: 'photorealistic studio photo of a female model wearing the product, fashion lookbook, natural pose',
  modelKid: 'photorealistic studio photo of a child model wearing the product, catalog photo, natural pose',
};

const viewLabels: Record<ViewKey, string> = {
  front: 'Front View',
  back: 'Back View',
  left: 'Left Side',
  right: 'Right Side',
  threeQuarter: '3/4 View',
  closeUp: 'Close-up View',
  top: 'Top View',
};

const allowedResolutions = new Set([512, 1024, 1536, 2048]);
const port = Number(process.env.PORT || 4000);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EDIT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_SLIDES = 20;
const MAX_VIDEO_UPLOAD_BYTES = 12 * 1024 * 1024;

const app = express();
const JSON_LEAK_KEYS = ['enhancedPrompt', 'negativePrompt'] as const;

// Safety net: ensure *any* JSON response emitted by routes/middleware can't leak enhancer fields,
// even if a future handler accidentally bypasses `safeJson`.
app.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((payload: any) => originalJson(stripKeysDeep(payload, JSON_LEAK_KEYS))) as any;
  next();
});

const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, '');
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => normalizeOrigin(origin.trim()))
  .filter(Boolean);
if (allowedOrigins.length) {
  allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001');
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!allowedOrigins.length) return callback(null, true);
      const normalizedOrigin = normalizeOrigin(origin);
      return callback(null, allowedOrigins.includes(normalizedOrigin));
    },
    allowedHeaders: ['Content-Type', 'x-user-id', 'Range'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    credentials: true,
  })
);

const jsonSmall = express.json({ limit: '5mb' });
const jsonLarge = express.json({ limit: '50mb' });
app.use('/api/designs', jsonLarge);
app.use('/api/realistic/render', jsonLarge);
app.use('/api/image/generate', jsonLarge);
app.use('/api/image/edit', jsonLarge);
app.use('/api/image/edit-views', jsonLarge);
app.use('/api/sam2', jsonLarge);
// These endpoints regularly receive base64-encoded images which can exceed the 5mb default.
app.use('/api/generate-base', jsonLarge);
app.use('/api/generate-views-from-base', jsonLarge);
app.use('/api/convert-style', jsonLarge);
app.use('/api/convert-model', jsonLarge);
app.use('/api/uniform/generate', jsonLarge);
app.use('/api/uniform/convert-style', jsonLarge);
app.use('/api/uniform/convert-model', jsonLarge);
app.use(jsonSmall);

// OpenAI Image Generation
app.use('/generated', express.static(path.join(process.cwd(), 'server', 'public', 'generated')));
app.post('/api/image/generate', generateImageHandler);

startAssetCleanup();

function mapGeminiError(err: any) {
  const msg = String(err?.message || err);

  if (msg.includes('API key not valid') || msg.includes('PERMISSION_DENIED')) {
    return 'Gemini API key is invalid or lacks permission.';
  }

  if (msg.includes('model') && msg.includes('not found')) {
    return 'Gemini model is unavailable.';
  }

  if (isRateLimitOrExhaustedError(err)) {
    return 'Gemini rate limit/quota exhausted. Please wait a bit and try again.';
  }

  if (msg.toLowerCase().includes('quota')) {
    return 'Gemini quota exceeded. Please try again later.';
  }

  return 'Gemini request failed. Check server logs.';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimitOrExhaustedError(err: any): boolean {
  const msg = String(err?.message || err).toLowerCase();
  if (msg.includes('429')) return true;
  if (msg.includes('resource_exhausted')) return true;
  if (msg.includes('resource exhausted')) return true;
  if (msg.includes('too many requests')) return true;
  return false;
}

async function generateContentWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: { attempts?: number; baseDelayMs?: number }
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 2));
  const baseDelayMs = Math.max(0, Math.floor(options?.baseDelayMs ?? 250));
  let lastErr: any = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isRateLimit = isRateLimitOrExhaustedError(err);
      const shouldRetry =
        attempt < attempts &&
        !msg.includes('API key not valid') &&
        !msg.includes('PERMISSION_DENIED') &&
        !msg.toLowerCase().includes('invalid_argument');

      if (!shouldRetry) break;
      const jitter = 0.8 + Math.random() * 0.6;
      const delayMs = isRateLimit
        ? Math.round(baseDelayMs * Math.pow(2, attempt - 1) * jitter)
        : Math.round(baseDelayMs * attempt);
      console.warn(
        `[gemini] ${label} failed (attempt ${attempt}/${attempts})${isRateLimit ? ' [rate-limit]' : ''}, retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Gemini request failed for ${label}.`);
}

function extractGeminiText(response: any): string {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof response?.text === 'string') return response.text.trim();
  return '';
}

function safeParseJsonObject<T>(raw: string): T | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  // Remove common markdown fences.
  const unfenced = trimmed.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // Attempt to extract the first JSON object substring.
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = unfenced.slice(start, end + 1);
      try {
        return JSON.parse(slice) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeLines(items: unknown, maxLen = 500): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'string') continue;
    const v = it
      .replace(/^\s*[-*•\d]+[.)\]]\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!v) continue;
    out.push(v.slice(0, maxLen));
  }
  return out;
}

function uniqStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const COMMON_SHORT_TAIL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'to',
  'with',
]);

const TITLE_DANGLING_TAIL_WORDS = new Set(['and', 'or', 'for', 'with', 'to', 'in', 'of', 'the', 'a', 'an']);

function trimToWordBoundary(input: string, maxLen: number): string {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen).trimEnd();
  const idx = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','), cut.lastIndexOf('|'));
  return (idx > 0 ? cut.slice(0, idx) : cut).replace(/[|,]\s*$/g, '').trimEnd();
}

function trimDanglingTailWordsForTitle(input: string): string {
  let s = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Trim any trailing punctuation/separators first.
  s = s.replace(/[|,;:\-–—]+$/g, '').trimEnd();
  // Remove trailing stopword(s) like "... play or".
  for (let i = 0; i < 3; i += 1) {
    const m = /(\s+)([A-Za-z]+)\s*$/.exec(s);
    if (!m) break;
    const word = (m[2] || '').toLowerCase();
    if (!TITLE_DANGLING_TAIL_WORDS.has(word)) break;
    s = s.slice(0, m.index).trimEnd();
    s = s.replace(/[|,;:\-–—]+$/g, '').trimEnd();
  }
  return s;
}

function trimIfLooksCutAtLimit(input: string, maxLen: number): string {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > maxLen) return trimToWordBoundary(s, maxLen);

  // If the model hit the exact limit and ended with a suspiciously short trailing word (e.g. "Mult"),
  // trim to the previous word boundary to avoid cut-off endings.
  if (s.length >= maxLen - 1) {
    const parts = s.split(/\s+/);
    const last = parts[parts.length - 1] ?? '';
    const lastClean = last.replace(/[^A-Za-z]/g, '');
    const lower = lastClean.toLowerCase();
    const endsWithPunct = /[.?!,:;)]$/.test(s);
    const looksShort = /^[A-Za-z]{2,4}$/.test(lastClean) && !COMMON_SHORT_TAIL_WORDS.has(lower);
    if (!endsWithPunct && looksShort) {
      const idx = s.lastIndexOf(' ');
      if (idx > 0) return s.slice(0, idx).replace(/[|,]\s*$/g, '').trimEnd();
    }
  }

  return s;
}

function buildTitlesPrompt(input: { productName: string; category?: string; count: number }) {
  return [
    'You are an ecommerce SEO assistant. Generate product listing titles.',
    `Product name: "${input.productName}".`,
    input.category ? `Category context (optional): "${input.category}".` : '',
    `Generate exactly ${input.count} unique titles.`,
    'Rules: each title MUST be 100–120 characters (inclusive) and MUST NOT exceed 120; end on a complete word (no cut-off last word).',
    "Do NOT end with a dangling connector/article (e.g. don't end with: and, or, for, with, to, in, of, the, a, an).",
    'Include buyer-intent keywords and (when relevant) material, style, season, audience, gift intent, and use case.',
    'Keep titles relevant to the product; do not invent a different primary product type (e.g. do not turn a hoodie into a t-shirt).',
    'Avoid duplicates; no numbering; no extra commentary.',
    'Return ONLY valid JSON in this exact shape: {"titles":["..."]}',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildKeywordsPrompt(input: { productName: string; category?: string; count: number }) {
  return [
    'You are an ecommerce SEO assistant. Generate search keywords for a product listing.',
    `Product name: "${input.productName}".`,
    input.category ? `Category context (optional): "${input.category}".` : '',
    `Generate exactly ${input.count} unique keywords.`,
    'Rules: mix short + long-tail; include generic + broad search intents plus specific buyer-intent phrases.',
    'Include synonyms, themes, style descriptors, audience/recipient, occasions, and use-cases when relevant.',
    'Keep keywords relevant to the product; do not invent a different primary product type (e.g. do not turn a hoodie into a t-shirt).',
    'Avoid duplicates; no numbering; no extra commentary.',
    'Return ONLY valid JSON in this exact shape: {"keywords":["..."]}',
  ]
    .filter(Boolean)
    .join(' ');
}

const TEXT_MODEL_CANDIDATES = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'] as const;

async function generateTextJsonWithModelFallback<T>(label: string, prompt: string): Promise<T> {
  let lastErr: any = null;

  for (const model of TEXT_MODEL_CANDIDATES) {
    try {
      const response = await generateContentWithRetry(
        `${label} | ${model}`,
        () =>
          ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
          }),
        { attempts: 6, baseDelayMs: 900 }
      );

      const raw = extractGeminiText(response);
      const parsed = safeParseJsonObject<T>(raw);
      if (parsed) return parsed;

      // One strict retry for non-JSON responses.
      const retryPrompt = `${prompt} Return ONLY valid JSON.`;
      const retry = await generateContentWithRetry(
        `${label}-json-retry | ${model}`,
        () =>
          ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: retryPrompt }] }],
          }),
        { attempts: 4, baseDelayMs: 900 }
      );
      const retryParsed = safeParseJsonObject<T>(extractGeminiText(retry));
      if (retryParsed) return retryParsed;

      lastErr = new Error('Gemini returned non-JSON output.');
    } catch (err: any) {
      lastErr = err;
      if (isRateLimitOrExhaustedError(err)) break;
      const msg = String(err?.message || err);
      const isModelNotFound = msg.toLowerCase().includes('model') && msg.toLowerCase().includes('not found');
      if (!isModelNotFound) break;
      // Try next model.
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Gemini request failed for ${label}.`);
}

// Mongo is used only for persistence (saved designs/assets). In dev, allow the app to run without it so
// image generation endpoints still work. In production, default to requiring Mongo so features aren't silently lost.
const requireMongo = (() => {
  const configured = (process.env.REQUIRE_MONGO ?? '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return isProductionEnv();
})();

if (!process.env.MONGODB_URI) {
  const msg = '[server] MONGODB_URI is not set (persistence disabled)';
  if (requireMongo) {
    console.error(msg);
    process.exit(1);
  } else {
    console.warn(msg);
  }
} else {
  connectMongo().catch((err) => {
    console.error('Failed to connect to MongoDB', err);
    if (requireMongo) process.exit(1);
  });
}

const allowedStyles: StyleKey[] = ['realistic', '3d', 'lineart', 'watercolor', 'modelMale', 'modelFemale', 'modelKid'];
const allowedViews = new Set<ViewKey>(['front', 'back', 'left', 'right', 'threeQuarter', 'closeUp', 'top']);
const allowedBaseStyles = new Set<StyleKey>(['realistic', '3d', 'lineart', 'watercolor']);
const allowedUniformViews = new Set<UniformViewKey>(['front', 'back', 'left', 'right']);

const pngDataUrlRegex = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/i;
const imageDataUrlRegex = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

function isPngDataUrl(value: unknown) {
  return typeof value === 'string' && pngDataUrlRegex.test(value.trim());
}

function isImageDataUrl(value: unknown) {
  return typeof value === 'string' && imageDataUrlRegex.test(value.trim());
}

function dataUrlSizeBytes(value: string) {
  const trimmed = value.trim();
  const base64 = trimmed.split(',')[1] || '';
  return Math.floor((base64.length * 3) / 4);
}

function assertDataUrlSize(value: string) {
  if (dataUrlSizeBytes(value) > MAX_IMAGE_BYTES) {
    throw new Error('Image payload too large (max 12MB).');
  }
}

function assertEditDataUrlSize(value: string) {
  if (dataUrlSizeBytes(value) > MAX_EDIT_IMAGE_BYTES) {
    throw new Error('Image payload too large (max 8MB).');
  }
}

function base64SizeBytes(value: string) {
  const trimmed = value.trim();
  const base64 = trimmed.startsWith('data:') ? (trimmed.split(',')[1] || '') : trimmed;
  return Math.floor((base64.length * 3) / 4);
}

function assertBase64Size(value: string) {
  if (base64SizeBytes(value) > MAX_IMAGE_BYTES) {
    throw new Error('Image payload too large (max 12MB).');
  }
}

function normalizePngBase64(input: unknown) {
  if (typeof input !== 'string') throw new Error('Image must be a base64 string.');
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Image must be a base64 string.');
  if (trimmed.startsWith('data:image/png;base64,')) {
    const raw = trimmed.replace(/^data:image\/png;base64,/i, '');
    if (!raw) throw new Error('Invalid PNG data URL.');
    return raw;
  }
  return trimmed;
}

function pngBase64ToInlineData(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  assertBase64Size(normalized);
  return { mimeType: 'image/png', data: normalized };
}

async function normalizeGeminiOutputPngBase64(
  imageBase64: string,
  targetSize?: number,
  options?: { background?: { r: number; g: number; b: number; alpha: number } }
) {
  const raw = Buffer.from(String(imageBase64 || ''), 'base64');
  const background = options?.background ?? { r: 255, g: 255, b: 255, alpha: 1 };
  const pipeline = sharp(raw).ensureAlpha();
  const sized =
    typeof targetSize === 'number' && Number.isFinite(targetSize) && targetSize > 0
      ? pipeline.resize(targetSize, targetSize, { fit: 'contain', background, withoutEnlargement: true })
      : pipeline;
  const out = await sized.png().toBuffer();
  return out.toString('base64');
}

const TRANSPARENT_BG = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE_BG = { r: 255, g: 255, b: 255, alpha: 1 };
const WHITE_BACKGROUND_PROMPT = [
  'Background MUST be pure white (#FFFFFF), seamless and clean.',
  'Isolated subject on pure white background, ecommerce style.',
  'NO room, NO studio scene, NO windows, NO wall texture, NO background objects, NO floor.',
  'NO checkerboard, NO gray studio box, NO environment, NO props.',
  'NO frames, NO borders, NO boxes, NO mockups.',
  'NO shadows, NO floor shadows, NO reflections, NO gradients, NO vignette.',
].join(' ');

const NO_SHADOWS_PROMPT = 'NO shadows. NO cast shadows. NO floor shadows. NO drop shadows.';

const FULL_FRAME_POSITIVE_PROMPT = [
  'FRAMING: Full-length shot. Entire main subject fully visible head-to-toe (top-to-bottom).',
  'STRICT ZOOM: Zoomed-out framing. Subject appears smaller and occupies only ~60–70% of the image height.',
  'COMPOSITION: Centered subject with lots of whitespace. Leave ~15–25% empty margin around the subject on all sides.',
  'Subject fits comfortably inside the frame; never crop any part of the subject. Keep generous padding.',
].join(' ');

const FULL_FRAME_NEGATIVE_PROMPT = [
  'NO zoomed-in. NO close-up. NO tight framing. NO close camera.',
  'NO cropped edges. NO extreme crop. NO partial view. NO cut-off legs. NO cut-off sleeves.',
].join(' ');

const TRANSPARENT_CUTOUT_PROMPT = [
  'Background MUST be TRANSPARENT (PNG with alpha).',
  'Return a backgroundless cutout of the uniform only.',
  'Do NOT render a checkerboard pattern (no baked transparency preview). Use true alpha transparency.',
  'IMPORTANT: Do NOT include checkerboard, white studio, or gray background. Output must be a transparent PNG cutout.',
  'NO wall, NO floor, NO studio environment.',
  'NO shadows, NO reflections, NO gradients, NO vignette.',
].join(' ');

function wantsTransparentBackground() {
  return false;
}

function promptRequestsNonWhiteBackground(promptRaw: unknown) {
  const prompt = typeof promptRaw === 'string' ? promptRaw.toLowerCase() : '';
  const p = prompt.trim();
  if (!p) return false;

  // Explicit requests for white background should still be treated as "white background ok".
  if (p.includes('#ffffff') || p.includes('pure white') || p.includes('plain white') || p.includes('white background')) {
    return false;
  }

  // Explicit non-white/scene requests. Keep this STRICT to avoid false positives like "streetwear" or "floor length".
  if (p.includes('transparent background') || p.includes('checkerboard')) return true;
  if (p.includes('gradient background') || p.includes('pattern background') || p.includes('textured background')) return true;

  // If the user explicitly mentions a background/backdrop color other than white.
  if (/\b(background|backdrop)\b/.test(p) && /\b(black|blue|red|green|yellow|pink|purple|orange|grey|gray|color(ed)?|colou?r(ed)?)\b/.test(p)) {
    return true;
  }

  // If the user explicitly requests an environment/scene (word-boundary matches to avoid "streetwear").
  if (/\b(outdoors?|outdoor)\b/.test(p)) return true;
  if (/\b(studio scene|studio set|in a studio|in the studio)\b/.test(p)) return true;
  if (/\b(in|on|at)\s+(a|the)\s+(room|interior|street|city|forest|beach|mountain|park)\b/.test(p)) return true;
  if (/\b(environment|scene)\b/.test(p) && !/\b(no|without)\s+(environment|scene)\b/.test(p)) return true;

  // Color/texture/gradient background requests.
  return false;
}

function shouldForceWhiteBackgroundFromPrompt(prompt: string) {
  // Default is white background unless the user explicitly requests a non-white / scene background.
  return !promptRequestsNonWhiteBackground(prompt);
}

async function hasMeaningfulTransparency(pngBase64: string, sampleSize = 64) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const { data } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .resize(sampleSize, sampleSize, { fit: 'fill' })
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (const a of data) if (a < 240) transparent += 1;
  const total = data.length || 1;
  return transparent / total >= 0.01;
}

async function sampleTransparentRatio(pngBase64: string, sampleSize = 64) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const { data } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .resize(sampleSize, sampleSize, { fit: 'fill' })
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (const a of data) if (a < 240) transparent += 1;
  const total = data.length || 1;
  return transparent / total;
}

async function alphaBoundingBox(pngBase64: string, alphaThreshold = 8) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha();
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('Alpha bbox: missing dimensions.');

  const { data } = await img.extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[y * width + x];
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return { left: 0, top: 0, width, height, imgWidth: width, imgHeight: height };
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, imgWidth: width, imgHeight: height };
}

async function applyAlphaFromReferencePngBase64(convertedPngBase64: string, referencePngBase64: string) {
  const converted = Buffer.from(normalizePngBase64(convertedPngBase64), 'base64');
  const reference = Buffer.from(normalizePngBase64(referencePngBase64), 'base64');

  const meta = await sharp(converted, { failOn: 'none' }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalizePngBase64(convertedPngBase64);

  const alpha = await sharp(reference, { failOn: 'none' })
    .ensureAlpha()
    .extractChannel(3)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = await sharp(converted, { failOn: 'none' })
    .ensureAlpha()
    .removeAlpha()
    .joinChannel(alpha.data, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return out.toString('base64');
}

async function tryMakeBackgroundTransparent(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha();
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const samplePx = Math.max(1, Math.floor(Math.min(width, height) * 0.06));
  const corners = [
    { left: 0, top: 0 },
    { left: width - samplePx, top: 0 },
    { left: 0, top: height - samplePx },
    { left: width - samplePx, top: height - samplePx },
  ];

  const cornerMeans: Array<{ r: number; g: number; b: number }> = [];
  for (const c of corners) {
    const { data } = await sharp(buf, { failOn: 'none' })
      .ensureAlpha()
      .extract({ left: c.left, top: c.top, width: samplePx, height: samplePx })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    const count = Math.max(1, Math.floor(data.length / 4));
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    cornerMeans.push({ r: r / count, g: g / count, b: b / count });
  }

  const mean = cornerMeans.reduce(
    (acc, c) => ({
      r: acc.r + c.r / cornerMeans.length,
      g: acc.g + c.g / cornerMeans.length,
      b: acc.b + c.b / cornerMeans.length,
    }),
    { r: 0, g: 0, b: 0 }
  );
  const variance =
    cornerMeans.reduce((acc, c) => {
      const dr = c.r - mean.r;
      const dg = c.g - mean.g;
      const db = c.b - mean.b;
      return acc + dr * dr + dg * dg + db * db;
    }, 0) / cornerMeans.length;
  if (variance > 250) return normalized;

  const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  let removed = 0;
  const total = Math.max(1, info.width * info.height);
  const thr = 38;

  for (let i = 0; i < out.length; i += 4) {
    const r = out[i];
    const g = out[i + 1];
    const b = out[i + 2];
    const dr = r - mean.r;
    const dg = g - mean.g;
    const db = b - mean.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const isNeutral = max - min <= 24;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (isNeutral && dist <= thr && luma >= 120) {
      out[i + 3] = 0;
      removed += 1;
    }
  }

  const removedRatio = removed / total;
  if (removedRatio < 0.05 || removedRatio > 0.9) return normalized;

  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return png.toString('base64');
}

function quantizeRgbKey(r: number, g: number, b: number, step = 16) {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v / step) * step));
  return `${q(r)}_${q(g)}_${q(b)}`;
}

async function makeBackgroundTransparentByPalette(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha();
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const samplePx = Math.max(1, Math.floor(Math.min(width, height) * 0.08));
  const corners = [
    { left: 0, top: 0 },
    { left: width - samplePx, top: 0 },
    { left: 0, top: height - samplePx },
    { left: width - samplePx, top: height - samplePx },
  ];

  const counts = new Map<string, number>();
  const sums = new Map<string, { r: number; g: number; b: number; n: number }>();
  for (const c of corners) {
    const { data } = await sharp(buf, { failOn: 'none' })
      .ensureAlpha()
      .extract({ left: c.left, top: c.top, width: samplePx, height: samplePx })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 200) continue;
      const key = quantizeRgbKey(r, g, b, 16);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const cur = sums.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.n += 1;
      sums.set(key, cur);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((acc, [, n]) => acc + n, 0) || 1;
  const top = sorted.slice(0, 3);
  if (!top.length) return normalized;

  const palette = top.map(([key, n]) => {
    const s = sums.get(key)!;
    return { r: s.r / s.n, g: s.g / s.n, b: s.b / s.n, w: n / total };
  });
  const coverage = palette.reduce((acc, c) => acc + c.w, 0);
  if (coverage < 0.8) return normalized;

  const lumaOf = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const allNeutral = palette.every((c) => {
    const max = Math.max(c.r, c.g, c.b);
    const min = Math.min(c.r, c.g, c.b);
    return max - min <= 18;
  });
  if (!allNeutral) return normalized;

  const allBright = palette.every((c) => lumaOf(c) >= 150);
  const allDark = palette.every((c) => lumaOf(c) <= 70);
  if (!allBright && !allDark) return normalized;

  const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  let removed = 0;
  const pxTotal = Math.max(1, info.width * info.height);

  const distTo = (c: { r: number; g: number; b: number }, r: number, g: number, b: number) => {
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  for (let i = 0; i < out.length; i += 4) {
    const r = out[i];
    const g = out[i + 1];
    const b = out[i + 2];
    const a = out[i + 3];
    if (a < 10) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const isNeutral = max - min <= 18;
    if (!isNeutral) continue;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let best = Infinity;
    for (const c of palette) best = Math.min(best, distTo(c, r, g, b));
    if (allBright) {
      // Allow a bigger threshold for neutral bright pixels to also remove light shadows.
      const thr = luma >= 200 ? 42 : luma >= 170 ? 34 : 26;
      if (best <= thr && luma >= 160) {
        out[i + 3] = 0;
        removed += 1;
      }
      continue;
    }

    // Dark/black matte or frame case: remove pixels close to corner black.
    // Use a conservative threshold and only for darker pixels to avoid nuking the subject.
    const thrDark = luma <= 35 ? 40 : luma <= 60 ? 28 : 18;
    if (best <= thrDark && luma <= 90) {
      out[i + 3] = 0;
      removed += 1;
    }
  }

  const removedRatio = removed / pxTotal;
  if (removedRatio < 0.03 || removedRatio > 0.98) return normalized;
  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return png.toString('base64');
}

async function ensureBackgroundlessPngBase64(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  // Only keep as-is if there is a large transparent region (not just anti-aliased edges).
  const alphaRatio = await sampleTransparentRatio(normalized).catch(() => 0);
  if (alphaRatio >= 0.15) return normalized;

  // Try single-color background keying first.
  const keyed = await tryMakeBackgroundTransparent(normalized);
  if ((await sampleTransparentRatio(keyed).catch(() => 0)) >= 0.15) return keyed;

  // Try checkerboard/multi-tone neutral palette keying.
  const pal = await makeBackgroundTransparentByPalette(normalized);
  if ((await sampleTransparentRatio(pal).catch(() => 0)) >= 0.15) return pal;

  return normalized;
}

async function ensureBackgroundlessPngBase64Strict(pngBase64: string) {
  let out = await ensureBackgroundlessPngBase64(pngBase64);
  const alphaRatio = await sampleTransparentRatio(out).catch(() => 0);
  if (alphaRatio < 0.15) {
    out = await ensureBackgroundlessPngBase64(out);
  }
  const alphaRatio2 = await sampleTransparentRatio(out).catch(() => 0);
  if (alphaRatio2 < 0.15) {
    out = await floodFillBackgroundCutout(out).catch(() => out);
  }
  return out;
}

async function ensureSolidWhiteBackgroundPngBase64(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const out = await sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: WHITE_BG }).png().toBuffer();
  return out.toString('base64');
}

async function ensureSolidWhiteBackgroundStrict(pngBase64: string) {
  // If Gemini returns a baked checkerboard/boxes, attempt a background mask (flood fill),
  // then flatten to pure white so the user never sees transparency boxes.
  let out = await ensureSolidWhiteBackgroundPngBase64(pngBase64);

  const alphaRatio = await sampleTransparentRatio(out).catch(() => 0);
  // If still partially transparent (rare) or if background looks patterned, fix using flood fill cutout.
  if (alphaRatio > 0.01) {
    out = await ensureSolidWhiteBackgroundPngBase64(out);
  }

  // Detect checkerboard-like border by looking for multiple neutral tones along the border.
  try {
    const buf = Buffer.from(normalizePngBase64(out), 'base64');
    const { data, info } = await sharp(buf, { failOn: 'none' })
      .resize(128, 128, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const tones = new Set<number>();
    const add = (v: number) => tones.add(Math.round(v / 16) * 16);
    for (let x = 0; x < w; x += 1) {
      add(data[x]);
      add(data[(h - 1) * w + x]);
    }
    for (let y = 0; y < h; y += 1) {
      add(data[y * w]);
      add(data[y * w + (w - 1)]);
    }
    if (tones.size >= 4) {
      const cut = await floodFillBackgroundCutout(out);
      out = await ensureSolidWhiteBackgroundPngBase64(cut);
    }
  } catch {
    // ignore detection errors
  }

  return out;
}

async function scoreCroppingRiskOnWhiteBackground(pngBase64: string) {
  const buf = Buffer.from(normalizePngBase64(pngBase64), 'base64');
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .flatten({ background: WHITE_BG })
    .resize(96, 96, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const isInk = (v: number) => v < 245;
  let edgeInk = 0;
  for (let x = 0; x < w; x += 1) {
    if (isInk(data[x])) edgeInk += 1;
    if (isInk(data[(h - 1) * w + x])) edgeInk += 1;
  }
  for (let y = 0; y < h; y += 1) {
    if (isInk(data[y * w])) edgeInk += 1;
    if (isInk(data[y * w + (w - 1)])) edgeInk += 1;
  }
  return edgeInk;
}

async function floodFillBackgroundCutout(pngBase64: string, sampleSize = 256) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');

  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (!origW || !origH) return normalized;

  const { data, info } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .resize(sampleSize, sampleSize, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height) return normalized;

  const idx = (x: number, y: number) => (y * width + x) * 4;
  const isNeutral = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) <= 48;
  const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const dist = (c: { r: number; g: number; b: number }, r: number, g: number, b: number) => {
    const dr = r - c.r;
    const dg = g - c.g;
    const db = b - c.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  // Build a small palette from the border (handles checkerboards and studio mats).
  const counts = new Map<string, number>();
  const sums = new Map<string, { r: number; g: number; b: number; n: number }>();
  const add = (r: number, g: number, b: number) => {
    const key = quantizeRgbKey(r, g, b, 16);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const cur = sums.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    cur.r += r;
    cur.g += g;
    cur.b += b;
    cur.n += 1;
    sums.set(key, cur);
  };

  const addBorderPixel = (x: number, y: number) => {
    const o = idx(x, y);
    const a = data[o + 3];
    if (a < 200) return;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (!isNeutral(r, g, b)) return;
    add(r, g, b);
  };

  for (let x = 0; x < width; x += 1) {
    addBorderPixel(x, 0);
    addBorderPixel(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    addBorderPixel(0, y);
    addBorderPixel(width - 1, y);
  }

  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => {
      const s = sums.get(k)!;
      return { r: s.r / s.n, g: s.g / s.n, b: s.b / s.n };
    });
  if (!palette.length) return normalized;

  // Decide whether this is mostly bright or mostly dark background.
  const paletteLuma = palette.map((c) => luma(c.r, c.g, c.b));
  const isBrightBg = paletteLuma.reduce((acc, v) => acc + v, 0) / paletteLuma.length >= 140;
  const maxDist = isBrightBg ? 78 : 60;

  const canBeBackground = (x: number, y: number) => {
    const o = idx(x, y);
    const a = data[o + 3];
    if (a < 10) return true;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (!isNeutral(r, g, b)) return false;
    const lum = luma(r, g, b);
    if (isBrightBg) {
      if (lum < 110) return false;
    } else {
      if (lum > 120) return false;
    }
    let best = Infinity;
    for (const c of palette) best = Math.min(best, dist(c, r, g, b));
    return best <= maxDist;
  };

  const visited = new Uint8Array(width * height);
  const bg = new Uint8Array(width * height);
  const qx = new Int32Array(width * height);
  const qy = new Int32Array(width * height);
  let qh = 0;
  let qt = 0;

  const enqueue = (x: number, y: number) => {
    const i = y * width + x;
    if (visited[i]) return;
    visited[i] = 1;
    if (!canBeBackground(x, y)) return;
    bg[i] = 1;
    qx[qt] = x;
    qy[qt] = y;
    qt += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (qh < qt) {
    const x = qx[qh];
    const y = qy[qh];
    qh += 1;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }

  const maskSmall = Buffer.alloc(width * height);
  for (let i = 0; i < maskSmall.length; i += 1) {
    maskSmall[i] = bg[i] ? 0 : 255;
  }

  const maskResized = await sharp(maskSmall, { raw: { width, height, channels: 1 } })
    .resize(origW, origH, { fit: 'fill' })
    .blur(0.6)
    .threshold(128)
    .raw()
    .toBuffer();

  const out = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .removeAlpha()
    .joinChannel(maskResized, { raw: { width: origW, height: origH, channels: 1 } })
    .png()
    .toBuffer();
  return out.toString('base64');
}

async function getPngDimensions(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('Image is missing dimensions.');
  return { width, height };
}

async function resizeToMatch(
  pngBase64: string,
  target: { width: number; height: number },
  background: { r: number; g: number; b: number; alpha: number }
) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const out = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .resize(target.width, target.height, { fit: 'contain', background, withoutEnlargement: true })
    .png()
    .toBuffer();
  return out.toString('base64');
}

async function cropLineArtToInkBoundingBox(pngBase64: string, margin = 16) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = data[y * width + x];
      // ink stroke threshold (black-ish)
      if (v <= 220) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return normalized;

  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const right = Math.min(width - 1, maxX + margin);
  const bottom = Math.min(height - 1, maxY + margin);
  const w = Math.max(1, right - left + 1);
  const h = Math.max(1, bottom - top + 1);

  const cropped = await sharp(buf, { failOn: 'none' }).extract({ left, top, width: w, height: h }).png().toBuffer();
  return cropped.toString('base64');
}

async function stripLineArtBorderLines(pngBase64: string, maxBorder = 18) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  // Be a bit more tolerant than pure black to catch gray-ish frame lines.
  const darkThreshold = 90;
  const rowDarkRatio = (y: number) => {
    let dark = 0;
    for (let x = 0; x < width; x += 1) if (out[y * width + x] <= darkThreshold) dark += 1;
    return dark / width;
  };
  const colDarkRatio = (x: number) => {
    let dark = 0;
    for (let y = 0; y < height; y += 1) if (out[y * width + x] <= darkThreshold) dark += 1;
    return dark / height;
  };

  const whitenRow = (y: number) => {
    for (let x = 0; x < width; x += 1) out[y * width + x] = 255;
  };
  const whitenCol = (x: number) => {
    for (let y = 0; y < height; y += 1) out[y * width + x] = 255;
  };

  for (let i = 0; i < Math.min(maxBorder, height); i += 1) {
    if (rowDarkRatio(i) > 0.6) whitenRow(i);
    if (rowDarkRatio(height - 1 - i) > 0.6) whitenRow(height - 1 - i);
  }
  for (let i = 0; i < Math.min(maxBorder, width); i += 1) {
    if (colDarkRatio(i) > 0.6) whitenCol(i);
    if (colDarkRatio(width - 1 - i) > 0.6) whitenCol(width - 1 - i);
  }

  const png = await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return png.toString('base64');
}

async function stripLineArtHorizontalRules(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);

  const darkThreshold = 90;
  const rowDarkRatio = (y: number) => {
    let dark = 0;
    for (let x = 0; x < width; x += 1) if (out[y * width + x] <= darkThreshold) dark += 1;
    return dark / width;
  };
  const whitenRow = (y: number) => {
    for (let x = 0; x < width; x += 1) out[y * width + x] = 255;
  };

  const topBand = Math.floor(height * 0.22);
  const bottomStart = Math.floor(height * 0.78);

  const candidate = (y: number) => rowDarkRatio(y) > 0.75;
  const segments: Array<{ start: number; end: number }> = [];
  let y = 0;
  while (y < height) {
    if (!candidate(y)) {
      y += 1;
      continue;
    }
    let start = y;
    while (y + 1 < height && candidate(y + 1)) y += 1;
    let end = y;
    segments.push({ start, end });
    y += 1;
  }

  for (const seg of segments) {
    const mid = (seg.start + seg.end) / 2;
    const nearTop = mid <= topBand;
    const nearBottom = mid >= bottomStart;
    if (!nearTop && !nearBottom) continue;
    const pad = 2;
    const s = Math.max(0, seg.start - pad);
    const e = Math.min(height - 1, seg.end + pad);
    for (let yy = s; yy <= e; yy += 1) whitenRow(yy);
  }

  const png = await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return png.toString('base64');
}

async function stripLineArtFullWidthRulesOutsideInk(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return normalized;

  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);

  const bbox = await computeInkBoundingBox(normalized, 220);
  const topLimit = Math.max(0, bbox.top - 12);
  const bottomLimit = Math.min(height - 1, bbox.top + bbox.height + 12);

  const darkThreshold = 90;
  const rowDarkRatio = (y: number) => {
    let dark = 0;
    for (let x = 0; x < width; x += 1) if (out[y * width + x] <= darkThreshold) dark += 1;
    return dark / width;
  };
  const whitenRow = (y: number) => {
    for (let x = 0; x < width; x += 1) out[y * width + x] = 255;
  };

  for (let y = 0; y < height; y += 1) {
    if (rowDarkRatio(y) < 0.85) continue;
    if (y >= topLimit && y <= bottomLimit) continue;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy += 1) {
      if (rowDarkRatio(yy) >= 0.7) whitenRow(yy);
    }
  }

  const png = await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return png.toString('base64');
}

async function computeInkBoundingBox(pngBase64: string, inkThreshold = 220) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('Line art bbox: missing dimensions.');
  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = data[y * width + x];
      if (v <= inkThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return { left: 0, top: 0, width, height };
  }

  const left = Math.max(0, minX);
  const top = Math.max(0, minY);
  const right = Math.min(width - 1, maxX);
  const bottom = Math.min(height - 1, maxY);
  return { left, top, width: Math.max(1, right - left + 1), height: Math.max(1, bottom - top + 1) };
}

async function computeNonWhiteBoundingBox(pngBase64: string, nonWhiteThreshold = 245) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('Content bbox: missing dimensions.');

  const { data } = await img.grayscale().raw().toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = data[y * width + x];
      if (v < nonWhiteThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return { left: 0, top: 0, width, height };
  }

  const margin = Math.max(6, Math.floor(Math.min(width, height) * 0.02));
  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const right = Math.min(width - 1, maxX + margin);
  const bottom = Math.min(height - 1, maxY + margin);
  return { left, top, width: Math.max(1, right - left + 1), height: Math.max(1, bottom - top + 1) };
}

async function normalizeLineArtToTargetSize(
  pngBase64: string,
  target: { width: number; height: number },
  referenceBox?: { width: number; height: number }
) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) throw new Error('Line art normalize: missing dimensions.');

  // Remove border/frames before bbox analysis.
  let cleaned = await stripLineArtBorderLines(normalized, 18);
  cleaned = await stripLineArtHorizontalRules(cleaned);
  const bbox = await computeInkBoundingBox(cleaned, 220);

  // Target occupancy to keep front/back consistent.
  // If a reference content box is provided (from the original colored render), match that size.
  const desiredH = Math.max(1, Math.round((referenceBox?.height ?? target.height * 0.78) as number));
  const desiredW = Math.max(1, Math.round((referenceBox?.width ?? target.width * 0.78) as number));
  const scaleH = desiredH / Math.max(1, bbox.height);
  const scaleW = desiredW / Math.max(1, bbox.width);
  let scale = Math.min(scaleH, scaleW);
  scale = Math.max(0.5, Math.min(3.0, scale));

  const scaledW = Math.max(1, Math.round(srcW * scale));
  const scaledH = Math.max(1, Math.round(srcH * scale));
  const scaled = await sharp(Buffer.from(cleaned, 'base64'), { failOn: 'none' })
    .resize(scaledW, scaledH, { fit: 'fill' })
    .png()
    .toBuffer();

  // Center-crop if oversized; otherwise pad to target.
  if (scaledW >= target.width && scaledH >= target.height) {
    const left = Math.max(0, Math.floor((scaledW - target.width) / 2));
    const top = Math.max(0, Math.floor((scaledH - target.height) / 2));
    const cropped = await sharp(scaled, { failOn: 'none' })
      .extract({ left, top, width: target.width, height: target.height })
      .png()
      .toBuffer();
    let out = cropped.toString('base64');
    out = await stripLineArtHorizontalRules(out);
    out = await stripLineArtFullWidthRulesOutsideInk(out);
    return out;
  }

  const background = { r: 255, g: 255, b: 255, alpha: 1 };
  const left = Math.max(0, Math.floor((target.width - scaledW) / 2));
  const top = Math.max(0, Math.floor((target.height - scaledH) / 2));
  const padded = await sharp({
    create: { width: target.width, height: target.height, channels: 4, background },
  })
    .composite([{ input: scaled, left, top }])
    .png()
    .toBuffer();
  let out = padded.toString('base64');
  out = await stripLineArtHorizontalRules(out);
  out = await stripLineArtFullWidthRulesOutsideInk(out);
  return out;
}

async function repairAlphaSpeckles(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height) return normalized;

  const out = Buffer.from(data);
  const idx = (x: number, y: number) => (y * width + x) * 4;
  let changed = 0;

  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const a = out[idx(x, y) + 3];
      if (a >= 120) continue;
      let opaqueNeighbors = 0;
      for (let ky = -2; ky <= 2; ky += 1) {
        for (let kx = -2; kx <= 2; kx += 1) {
          if (kx === 0 && ky === 0) continue;
          const na = out[idx(x + kx, y + ky) + 3];
          if (na >= 230) opaqueNeighbors += 1;
        }
      }
      if (opaqueNeighbors >= 16) {
        out[idx(x, y) + 3] = 255;
        changed += 1;
      }
    }
  }

  if (!changed) return normalized;
  const png = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return png.toString('base64');
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function validateDesignPayload(body: any) {
  const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
  const rawTitle = typeof body?.title === 'string' ? body.title.trim() : '';
  const name = rawName || rawTitle || 'Untitled Design';
  const title = name;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const style = body?.style as StyleKey;
  const resolution = Number(body?.resolution);
  const views = Array.isArray(body?.views) ? body.views : [];
  const composite = body?.composite;
  const images = Array.isArray(body?.images) ? body.images : [];
  const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';

  const normalizePngInput = (
    input: any
  ): { mime: 'image/png'; dataUrl?: string; url?: string } | null => {
    if (typeof input === 'string' && isPngDataUrl(input)) {
      return { mime: 'image/png', dataUrl: input };
    }
    if (input && typeof input === 'object') {
      if (typeof input.imageDataUrl === 'string') {
        if (isPngDataUrl(input.imageDataUrl)) return { mime: 'image/png', dataUrl: input.imageDataUrl };
        if (input.imageDataUrl.startsWith('/api/')) return { mime: 'image/png', url: input.imageDataUrl };
      }
      if (typeof input.src === 'string') {
        if (isPngDataUrl(input.src)) return { mime: 'image/png', dataUrl: input.src };
        if (input.src.startsWith('/api/')) return { mime: 'image/png', url: input.src };
      }
      if (typeof input.dataUrl === 'string' && isPngDataUrl(input.dataUrl)) {
        return { mime: 'image/png', dataUrl: input.dataUrl };
      }
      if (typeof input.url === 'string' && input.url.startsWith('/api/')) {
        return { mime: 'image/png', url: input.url };
      }
    }
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return { mime: 'image/png', url: input };
    }
    return null;
  };

  if (!prompt) return { ok: false, error: 'Prompt is required.' };
  if (!name || name.length > 60) return { ok: false, error: 'Name is required (max 60 chars).' };
  if (!userId) return { ok: false, error: 'Missing user id.' };
  if (!allowedStyles.includes(style)) return { ok: false, error: 'Invalid style.' };
  if (!allowedResolutions.has(resolution)) return { ok: false, error: 'Invalid resolution.' };
  if (!views.length) return { ok: false, error: 'At least one view is required.' };
  if (new Set(views).size !== views.length) return { ok: false, error: 'Views must be unique.' };
  if (!views.every((v) => allowedViews.has(v))) return { ok: false, error: 'Invalid view value.' };
  if (views.length > 6) return { ok: false, error: 'Maximum 6 views allowed.' };

  const normalizedComposite = composite ? normalizePngInput(composite) : null;
  if (composite && !normalizedComposite) return { ok: false, error: 'Composite must be a PNG data URL.' };
  if (images.length !== views.length) return { ok: false, error: 'Images must match number of views.' };

  const normalizedImages = images.map((img: any) => {
    const view = img?.view;
    const inputRaw = img?.dataUrl ?? img?.imageDataUrl ?? img?.src ?? img?.url;
    const input = typeof inputRaw === 'string' ? inputRaw : '';
    const normalized = normalizePngInput(input);
    return { view, ...normalized };
  });

  const viewSet = new Set(views);
  if (
    !normalizedImages.every(
      (img: any) =>
        typeof img.view === 'string' &&
        viewSet.has(img.view) &&
        (typeof img.dataUrl === 'string' || typeof img.url === 'string')
    )
  ) {
    return { ok: false, error: 'Each image must include a view and PNG data URL.' };
  }

  return {
    ok: true,
    data: {
      name,
      title,
      prompt,
      style,
      resolution,
      userId,
      views,
      composite: normalizedComposite,
      images: normalizedImages.map((img: any) => ({ view: img.view, mime: 'image/png' as const, dataUrl: img.dataUrl, url: img.url })),
    },
  };
}

function buildFileUrl(fileId?: string) {
  return fileId ? `/api/files/${fileId}` : undefined;
}

function dataUrlToBuffer(dataUrl: string) {
  const match = /^data:(image\/png);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid data URL');
  }
  return {
    mime: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function dataUrlToImageBuffer(dataUrl: string) {
  const match = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[3], 'base64'),
  };
}

function dataUrlToInlineData(dataUrl: string) {
  const match = /^data:(image\/png);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid data URL');
  }
  return { mimeType: match[1], data: match[2] };
}

function dataUrlToInlineImageData(dataUrl: string) {
  const match = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  return { mimeType: match[1].toLowerCase(), data: match[3] };
}

function parseSquareResolutionToTargetSize(value: unknown, fallback = 1024) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.round(value);
    return allowedResolutions.has(n) ? n : fallback;
  }

  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return fallback;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) return fallback;
  return allowedResolutions.has(w) ? w : fallback;
}

async function autoCropAndFitPng(
  pngBuffer: Buffer,
  targetSize: number,
  options: { mode: 'lineart' | 'photo' } = { mode: 'photo' }
): Promise<Buffer> {
  const decoded = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  const pixels = decoded.data;

  const readPixel = (x: number, y: number): [number, number, number, number] => {
    const i = (y * width + x) * channels;
    return [pixels[i] || 0, pixels[i + 1] || 0, pixels[i + 2] || 0, pixels[i + 3] ?? 255];
  };

  const corners = [
    readPixel(0, 0),
    readPixel(width - 1, 0),
    readPixel(0, height - 1),
    readPixel(width - 1, height - 1),
  ];
  const bg = corners.reduce<[number, number, number]>(
    (acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
    [0, 0, 0]
  );
  const bgAvg: [number, number, number] = [bg[0] / corners.length, bg[1] / corners.length, bg[2] / corners.length];
  const cornerDists = corners.map((c) => Math.sqrt(rgbDistSq([c[0], c[1], c[2]], bgAvg)));
  const maxCornerDist = cornerDists.length ? Math.max(...cornerDists) : 0;

  const bgBrightness = (bgAvg[0] + bgAvg[1] + bgAvg[2]) / 3;
  const baseThreshold = options.mode === 'lineart' ? 18 : 24;
  const distThreshold = baseThreshold + Math.min(40, maxCornerDist);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let fgCount = 0;

  const quad = [
    { minX: width, minY: height, maxX: -1, maxY: -1, count: 0 }, // TL
    { minX: width, minY: height, maxX: -1, maxY: -1, count: 0 }, // TR
    { minX: width, minY: height, maxX: -1, maxY: -1, count: 0 }, // BL
    { minX: width, minY: height, maxX: -1, maxY: -1, count: 0 }, // BR
  ];

  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const idx = rowOffset + x * channels;
      const r = pixels[idx] || 0;
      const g = pixels[idx + 1] || 0;
      const b = pixels[idx + 2] || 0;
      const a = pixels[idx + 3] ?? 255;
      if (a < 20) continue;

      const dist = Math.sqrt(rgbDistSq([r, g, b], bgAvg));
      const brightness = (r + g + b) / 3;
      const isForeground =
        options.mode === 'lineart' ? dist > distThreshold || brightness < bgBrightness - 18 : dist > distThreshold;
      if (!isForeground) continue;

      fgCount += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const q = (y < halfH ? 0 : 2) + (x < halfW ? 0 : 1);
      const qBox = quad[q];
      qBox.count += 1;
      if (x < qBox.minX) qBox.minX = x;
      if (y < qBox.minY) qBox.minY = y;
      if (x > qBox.maxX) qBox.maxX = x;
      if (y > qBox.maxY) qBox.maxY = y;
    }
  }

  const padBackground =
    options.mode === 'lineart'
      ? { r: 255, g: 255, b: 255, alpha: 1 }
      : { r: Math.round(bgAvg[0]), g: Math.round(bgAvg[1]), b: Math.round(bgAvg[2]), alpha: 1 };

  if (maxX < 0 || maxY < 0 || fgCount < 50) {
    return await sharp(pngBuffer)
      .resize({ width: targetSize, height: targetSize, fit: 'contain', background: padBackground })
      .png()
      .toBuffer();
  }

  let cropMinX = minX;
  let cropMinY = minY;
  let cropMaxX = maxX;
  let cropMaxY = maxY;

  const globalW = maxX - minX + 1;
  const globalH = maxY - minY + 1;
  const looksLikeCollage = globalW / width > 0.9 && globalH / height > 0.9;
  if (looksLikeCollage) {
    let bestIdx = 0;
    for (let i = 1; i < quad.length; i += 1) {
      if (quad[i].count > quad[bestIdx].count) bestIdx = i;
    }
    const best = quad[bestIdx];
    if (best.count > Math.max(500, fgCount * 0.15) && best.maxX >= 0 && best.maxY >= 0) {
      cropMinX = best.minX;
      cropMinY = best.minY;
      cropMaxX = best.maxX;
      cropMaxY = best.maxY;
    }
  }

  const cropW = cropMaxX - cropMinX + 1;
  const cropH = cropMaxY - cropMinY + 1;
  const padX = Math.max(2, Math.round(cropW * 0.06));
  const padY = Math.max(2, Math.round(cropH * 0.06));
  const left = Math.max(0, cropMinX - padX);
  const top = Math.max(0, cropMinY - padY);
  const right = Math.min(width - 1, cropMaxX + padX);
  const bottom = Math.min(height - 1, cropMaxY + padY);
  const extractW = Math.max(1, right - left + 1);
  const extractH = Math.max(1, bottom - top + 1);

  return await sharp(pngBuffer)
    .extract({ left, top, width: extractW, height: extractH })
    .resize({ width: targetSize, height: targetSize, fit: 'contain', background: padBackground })
    .png()
    .toBuffer();
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b)
    .toString(16)
    .padStart(2, '0')}`.toUpperCase();
}

function seededRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function rgbDistSq(a: [number, number, number], b: [number, number, number]) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

async function decodePngMaskDataUrlToRawMask(dataUrl: string, width: number, height: number) {
  const { buffer } = dataUrlToBuffer(dataUrl); // png only
  const decoded = await sharp(buffer)
    .ensureAlpha()
    .resize({ width, height, fit: 'fill', kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = decoded.info.channels;
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    out[i] = decoded.data[i * channels]; // grayscale from R channel
  }
  return out;
}

async function fallbackObjectMaskFromPoint(options: { imageDataUrl: string; x: number; y: number }) {
  const { buffer } = dataUrlToImageBuffer(options.imageDataUrl);

  const decoded = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 512, height: 512, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = decoded.info.width;
  const height = decoded.info.height;
  const channels = decoded.info.channels;
  const data = decoded.data;

  const px = Math.floor(clamp01(options.x) * (width - 1));
  const py = Math.floor(clamp01(options.y) * (height - 1));
  const seedIdx = (py * width + px) * channels;
  const seed: [number, number, number] = [data[seedIdx], data[seedIdx + 1], data[seedIdx + 2]];

  const visited = new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  const q = new Int32Array(width * height);
  let qh = 0;
  let qt = 0;
  const start = py * width + px;
  q[qt++] = start;
  visited[start] = 1;

  const tolSq = 26 * 26;
  const maxPixels = Math.floor(width * height * 0.45);

  while (qh < qt && qt < maxPixels) {
    const idx = q[qh++];
    mask[idx] = 255;

    const x = idx % width;
    const y = Math.floor(idx / width);
    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      const pOff = nIdx * channels;
      const rgb: [number, number, number] = [data[pOff], data[pOff + 1], data[pOff + 2]];
      if (rgbDistSq(rgb, seed) <= tolSq) {
        q[qt++] = nIdx;
      }
    }
  }

  // Smooth edges and fill tiny holes.
  const blurred = await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).blur(1.2).raw().toBuffer();
  const thresh = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    thresh[i] = blurred[i] >= 80 ? 255 : 0;
  }

  const png = await sharp(thresh, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function fallbackSplitColorsInMask(options: {
  imageDataUrl: string;
  objectMaskDataUrl: string;
  maxColors: number;
  minAreaRatio: number;
  seed: number;
}) {
  const { buffer } = dataUrlToImageBuffer(options.imageDataUrl);

  const decoded = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 512, height: 512, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = decoded.info.width;
  const height = decoded.info.height;
  const channels = decoded.info.channels;
  const data = decoded.data;

  const maskRaw = await decodePngMaskDataUrlToRawMask(options.objectMaskDataUrl, width, height);
  const objectIndices: number[] = [];
  for (let i = 0; i < width * height; i += 1) {
    if (maskRaw[i] >= 128) objectIndices.push(i);
  }
  const objectArea = objectIndices.length;
  if (!objectArea) throw new Error('Empty object mask.');

  const pixels: Array<[number, number, number]> = objectIndices.map((i) => {
    const off = i * channels;
    return [data[off], data[off + 1], data[off + 2]];
  });

  // Quick single-color detection.
  const sampleStep = Math.max(1, Math.floor(pixels.length / 8000));
  const sample: Array<[number, number, number]> = [];
  for (let i = 0; i < pixels.length; i += sampleStep) sample.push(pixels[i]);
  const mean = sample.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]] as [number, number, number], [0, 0, 0]);
  const meanRgb: [number, number, number] = [mean[0] / sample.length, mean[1] / sample.length, mean[2] / sample.length];
  const variance =
    sample.reduce((acc, p) => acc + rgbDistSq(p, meanRgb), 0) / Math.max(1, sample.length);
  if (variance < 30) {
    const png = await sharp(Buffer.from(maskRaw), { raw: { width, height, channels: 1 } }).png().toBuffer();
    return [
      {
        id: 'color-1',
        maskDataUrl: `data:image/png;base64,${png.toString('base64')}`,
        avgColor: rgbToHex(meanRgb[0], meanRgb[1], meanRgb[2]),
        areaPct: 1,
      },
    ];
  }

  const rng = seededRng(options.seed || 42);

  const runKmeans = (k: number) => {
    const centroids: Array<[number, number, number]> = [];
    for (let i = 0; i < k; i += 1) {
      const pick = sample[Math.floor(rng() * sample.length)] || sample[0];
      centroids.push([pick[0], pick[1], pick[2]]);
    }

    const iterations = 8;
    for (let it = 0; it < iterations; it += 1) {
      const sums = Array.from({ length: k }, () => [0, 0, 0, 0] as [number, number, number, number]);
      for (const px of sample) {
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let c = 0; c < k; c += 1) {
          const dist = rgbDistSq(px, centroids[c]);
          if (dist < bestDist) {
            bestDist = dist;
            best = c;
          }
        }
        sums[best][0] += px[0];
        sums[best][1] += px[1];
        sums[best][2] += px[2];
        sums[best][3] += 1;
      }
      for (let c = 0; c < k; c += 1) {
        const count = sums[c][3] || 1;
        centroids[c] = [sums[c][0] / count, sums[c][1] / count, sums[c][2] / count];
      }
    }

    let sse = 0;
    for (const px of sample) {
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c += 1) bestDist = Math.min(bestDist, rgbDistSq(px, centroids[c]));
      sse += bestDist;
    }
    return { centroids, sse };
  };

  const maxK = Math.min(Math.max(options.maxColors, 2), 10, sample.length);
  const sseByK: number[] = [];
  const models: Array<{ centroids: Array<[number, number, number]>; sse: number }> = [];
  // Include k=1 for stability.
  for (let k = 1; k <= maxK; k += 1) {
    const model = runKmeans(k);
    models.push(model);
    sseByK.push(model.sse);
  }

  let chosenK = 1;
  if (maxK >= 3) {
    let bestCurv = -Infinity;
    for (let k = 2; k <= maxK - 1; k += 1) {
      const curv = sseByK[k - 2] - 2 * sseByK[k - 1] + sseByK[k];
      if (curv > bestCurv) {
        bestCurv = curv;
        chosenK = k;
      }
    }
  } else if (maxK === 2) {
    // Choose k=2 only if it helps meaningfully.
    const improv = (sseByK[0] - sseByK[1]) / Math.max(1, sseByK[0]);
    chosenK = improv > 0.12 ? 2 : 1;
  }

  let centroids = models[chosenK - 1].centroids;
  // Merge very similar centroids.
  const parent = centroids.map((_, i) => i);
  const find = (a: number): number => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const mergeThresholdSq = 22 * 22;
  for (let i = 0; i < centroids.length; i += 1) {
    for (let j = i + 1; j < centroids.length; j += 1) {
      if (rgbDistSq(centroids[i], centroids[j]) <= mergeThresholdSq) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < centroids.length; i += 1) {
    const r = find(i);
    const arr = groups.get(r) || [];
    arr.push(i);
    groups.set(r, arr);
  }
  if (groups.size !== centroids.length) {
    const merged: Array<[number, number, number]> = [];
    for (const members of groups.values()) {
      const sum = members.reduce(
        (acc, idx) => [acc[0] + centroids[idx][0], acc[1] + centroids[idx][1], acc[2] + centroids[idx][2]] as [number, number, number],
        [0, 0, 0]
      );
      merged.push([sum[0] / members.length, sum[1] / members.length, sum[2] / members.length]);
    }
    centroids = merged;
  }

  // Assign pixels inside the object to the chosen/merged centroids.
  const labels = new Uint8Array(objectArea);
  const areas = new Array<number>(centroids.length).fill(0);
  for (let i = 0; i < objectArea; i += 1) {
    const px = pixels[i];
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let c = 0; c < centroids.length; c += 1) {
      const dist = rgbDistSq(px, centroids[c]);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    labels[i] = best;
    areas[best] += 1;
  }

  const minArea = Math.max(1, Math.floor(objectArea * options.minAreaRatio));
  const order = [...Array(centroids.length).keys()].sort((a, b) => areas[b] - areas[a]);
  const layers: Array<{ id: string; maskDataUrl: string; avgColor: string; areaPct: number }> = [];

  for (let outIdx = 0; outIdx < order.length; outIdx += 1) {
    const clusterIdx = order[outIdx];
    const area = areas[clusterIdx];
    if (area < minArea) continue;
    const maskOut = Buffer.alloc(width * height);
    for (let i = 0; i < objectArea; i += 1) {
      if (labels[i] !== clusterIdx) continue;
      maskOut[objectIndices[i]] = 255;
    }
    const png = await sharp(maskOut, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const centroid = centroids[clusterIdx];
    layers.push({
      id: `shirt-color-${layers.length + 1}`,
      maskDataUrl: `data:image/png;base64,${png.toString('base64')}`,
      avgColor: rgbToHex(centroid[0], centroid[1], centroid[2]),
      areaPct: area / objectArea,
    });
  }

  if (!layers.length) {
    const png = await sharp(Buffer.from(maskRaw), { raw: { width, height, channels: 1 } }).png().toBuffer();
    return [
      {
        id: 'shirt-color-1',
        maskDataUrl: `data:image/png;base64,${png.toString('base64')}`,
        avgColor: rgbToHex(meanRgb[0], meanRgb[1], meanRgb[2]),
        areaPct: 1,
      },
    ];
  }

  return layers;
}

async function fallbackKmeansColorLayers(options: {
  imageDataUrl: string;
  numLayers: number;
  blur: number;
  seed: number;
}) {
  const { buffer } = dataUrlToImageBuffer(options.imageDataUrl);

  const resized = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 512, height: 512, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = resized.info.width;
  const height = resized.info.height;
  const channels = resized.info.channels;
  const data = resized.data;

  if (!width || !height || channels < 3) {
    throw new Error('Failed to decode image for fallback.');
  }

  const k = Math.min(Math.max(options.numLayers, 2), 8);
  const rng = seededRng(options.seed || 42);

  // Sample pixels to train k-means.
  const sampleStep = Math.max(1, Math.floor((width * height) / 65000));
  const samples: Array<[number, number, number]> = [];
  for (let i = 0; i < width * height; i += sampleStep) {
    const idx = i * channels;
    samples.push([data[idx], data[idx + 1], data[idx + 2]]);
  }

  if (!samples.length) {
    throw new Error('No pixels available for fallback.');
  }

  const centroids: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i += 1) {
    const pick = samples[Math.floor(rng() * samples.length)] || samples[0];
    centroids.push([pick[0], pick[1], pick[2]]);
  }

  const iterations = 8;
  for (let it = 0; it < iterations; it += 1) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0] as [number, number, number, number]); // r,g,b,count
    for (const px of samples) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c += 1) {
        const dr = px[0] - centroids[c][0];
        const dg = px[1] - centroids[c][1];
        const db = px[2] - centroids[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      sums[best][0] += px[0];
      sums[best][1] += px[1];
      sums[best][2] += px[2];
      sums[best][3] += 1;
    }
    for (let c = 0; c < k; c += 1) {
      const count = sums[c][3] || 1;
      centroids[c] = [sums[c][0] / count, sums[c][1] / count, sums[c][2] / count];
    }
  }

  // Assign all pixels.
  const labels = new Uint8Array(width * height);
  const areas = new Array<number>(k).fill(0);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * channels;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let c = 0; c < k; c += 1) {
      const dr = r - centroids[c][0];
      const dg = g - centroids[c][1];
      const db = b - centroids[c][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    labels[i] = best;
    areas[best] += 1;
  }

  const order = [...Array(k).keys()].sort((a, b) => areas[b] - areas[a]).filter((idx) => areas[idx] > 0);

  const layers = await Promise.all(
    order.map(async (clusterIdx, outIdx) => {
      const maskRaw = Buffer.alloc(width * height);
      for (let i = 0; i < labels.length; i += 1) {
        maskRaw[i] = labels[i] === clusterIdx ? 255 : 0;
      }

      let maskForAlpha = maskRaw;
      if (options.blur > 0) {
        maskForAlpha = await sharp(maskRaw, { raw: { width, height, channels: 1 } })
          .blur(options.blur)
          .raw()
          .toBuffer();
      }

      const maskPngBuffer = await sharp(maskForAlpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
      const maskPng = `data:image/png;base64,${maskPngBuffer.toString('base64')}`;

      const rgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        const srcIdx = i * channels;
        const dstIdx = i * 4;
        rgba[dstIdx] = data[srcIdx];
        rgba[dstIdx + 1] = data[srcIdx + 1];
        rgba[dstIdx + 2] = data[srcIdx + 2];
        rgba[dstIdx + 3] = maskForAlpha[i];
      }
      const cutoutBuffer = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const cutoutPng = `data:image/png;base64,${cutoutBuffer.toString('base64')}`;

      const centroid = centroids[clusterIdx];
      return {
        id: randomUUID(),
        label: `Layer ${outIdx + 1}`,
        suggestedColor: rgbToHex(centroid[0], centroid[1], centroid[2]),
        maskPng,
        cutoutPng,
        area: areas[clusterIdx],
      };
    })
  );

  return { width, height, layers };
}

function rgbToLab(r: number, g: number, b: number) {
  // sRGB -> XYZ (D65) -> Lab
  const srgbToLinear = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;

  // D65 reference white
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116);
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [L, a, bb] as const;
}

function deltaE76(labA: readonly [number, number, number], labB: readonly [number, number, number]) {
  const dL = labA[0] - labB[0];
  const da = labA[1] - labB[1];
  const db = labA[2] - labB[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

async function fallbackKmeansColorLayersDynamic(options: {
  imageDataUrl: string;
  maxColors: number;
  minAreaRatio: number;
  mergeThreshold: number;
  seed: number;
}) {
  const { buffer } = dataUrlToImageBuffer(options.imageDataUrl);

  const resized = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 512, height: 512, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = resized.info.width;
  const height = resized.info.height;
  const channels = resized.info.channels;
  const data = resized.data;

  if (!width || !height || channels < 3) {
    throw new Error('Failed to decode image for fallback.');
  }

  const totalPixels = width * height;
  const seed = Number.isFinite(options.seed) ? Math.round(options.seed) : 42;
  const rng = seededRng(seed);

  // Precompute Lab for all pixels (used for clustering).
  const lab = new Float32Array(totalPixels * 3);
  for (let i = 0; i < totalPixels; i += 1) {
    const idx = i * channels;
    const [L, a, b] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
    const o = i * 3;
    lab[o] = L;
    lab[o + 1] = a;
    lab[o + 2] = b;
  }

  const sampleStep = Math.max(1, Math.floor(totalPixels / 50000));
  const samples: Array<[number, number, number]> = [];
  for (let i = 0; i < totalPixels; i += sampleStep) {
    const o = i * 3;
    samples.push([lab[o], lab[o + 1], lab[o + 2]]);
  }
  if (!samples.length) throw new Error('No pixels available for fallback.');

  const maxK = Math.min(Math.max(options.maxColors, 2), 10, samples.length);

  const trainKmeans = (k: number) => {
    const centroids: Array<[number, number, number]> = [];
    for (let i = 0; i < k; i += 1) {
      const pick = samples[Math.floor(rng() * samples.length)] || samples[0];
      centroids.push([pick[0], pick[1], pick[2]]);
    }

    const iterations = 8;
    for (let it = 0; it < iterations; it += 1) {
      const sums = Array.from({ length: k }, () => [0, 0, 0, 0] as [number, number, number, number]);
      for (const px of samples) {
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let c = 0; c < k; c += 1) {
          const d0 = px[0] - centroids[c][0];
          const d1 = px[1] - centroids[c][1];
          const d2 = px[2] - centroids[c][2];
          const dist = d0 * d0 + d1 * d1 + d2 * d2;
          if (dist < bestDist) {
            bestDist = dist;
            best = c;
          }
        }
        sums[best][0] += px[0];
        sums[best][1] += px[1];
        sums[best][2] += px[2];
        sums[best][3] += 1;
      }
      for (let c = 0; c < k; c += 1) {
        const count = sums[c][3] || 1;
        centroids[c] = [sums[c][0] / count, sums[c][1] / count, sums[c][2] / count];
      }
    }

    // Inertia on samples.
    let inertia = 0;
    for (const px of samples) {
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c += 1) {
        const d0 = px[0] - centroids[c][0];
        const d1 = px[1] - centroids[c][1];
        const d2 = px[2] - centroids[c][2];
        const dist = d0 * d0 + d1 * d1 + d2 * d2;
        if (dist < bestDist) bestDist = dist;
      }
      inertia += bestDist;
    }

    return { centroids, inertia };
  };

  let prevInertia: number | null = null;
  let best = trainKmeans(2);
  let bestK = 2;
  for (let k = 3; k <= maxK; k += 1) {
    const model = trainKmeans(k);
    if (prevInertia != null) {
      const improvement = (prevInertia - model.inertia) / Math.max(prevInertia, 1e-9);
      if (improvement < 0.08) {
        break;
      }
    }
    prevInertia = model.inertia;
    best = model;
    bestK = k;
  }

  const centroids = best.centroids;
  const labels = new Uint8Array(totalPixels);
  const areas = new Array<number>(bestK).fill(0);
  const sumRgb = Array.from({ length: bestK }, () => [0, 0, 0] as [number, number, number]);

  for (let i = 0; i < totalPixels; i += 1) {
    const o = i * 3;
    const L = lab[o];
    const a = lab[o + 1];
    const b = lab[o + 2];
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let c = 0; c < bestK; c += 1) {
      const d0 = L - centroids[c][0];
      const d1 = a - centroids[c][1];
      const d2 = b - centroids[c][2];
      const dist = d0 * d0 + d1 * d1 + d2 * d2;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = c;
      }
    }
    labels[i] = bestIdx;
    areas[bestIdx] += 1;
    const src = i * channels;
    sumRgb[bestIdx][0] += data[src];
    sumRgb[bestIdx][1] += data[src + 1];
    sumRgb[bestIdx][2] += data[src + 2];
  }

  // Background removal heuristic: dominant border cluster.
  const borderCounts = new Array<number>(bestK).fill(0);
  const addBorder = (i: number) => {
    borderCounts[labels[i]] += 1;
  };
  for (let x = 0; x < width; x += 1) {
    addBorder(x);
    addBorder((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    addBorder(y * width);
    addBorder(y * width + (width - 1));
  }
  const borderTotal = borderCounts.reduce((a, b) => a + b, 0) || 1;
  let borderDom = 0;
  for (let c = 1; c < bestK; c += 1) {
    if (borderCounts[c] > borderCounts[borderDom]) borderDom = c;
  }
  const borderRatio = borderCounts[borderDom] / borderTotal;

  const minArea = Math.floor(totalPixels * Math.min(Math.max(options.minAreaRatio, 0), 0.5));
  const removed = new Set<number>();
  if (bestK > 2 && borderRatio >= 0.6 && areas[borderDom] / totalPixels >= 0.15) {
    removed.add(borderDom);
  }

  for (let c = 0; c < bestK; c += 1) {
    if (areas[c] < minArea) removed.add(c);
  }

  // Merge near-identical clusters (ΔE threshold) using union-find.
  const parent = Array.from({ length: bestK }, (_, i) => i);
  const find = (a: number) => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const centroidLab = centroids.map((c) => [c[0], c[1], c[2]] as const);
  for (let i = 0; i < bestK; i += 1) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < bestK; j += 1) {
      if (removed.has(j)) continue;
      if (deltaE76(centroidLab[i], centroidLab[j]) < options.mergeThreshold) {
        unite(i, j);
      }
    }
  }

  const rootInfo = new Map<number, { area: number; sumRgb: [number, number, number] }>();
  for (let c = 0; c < bestK; c += 1) {
    if (removed.has(c)) continue;
    const root = find(c);
    const entry = rootInfo.get(root) || { area: 0, sumRgb: [0, 0, 0] as [number, number, number] };
    entry.area += areas[c];
    entry.sumRgb[0] += sumRgb[c][0];
    entry.sumRgb[1] += sumRgb[c][1];
    entry.sumRgb[2] += sumRgb[c][2];
    rootInfo.set(root, entry);
  }

  const roots = Array.from(rootInfo.entries()).sort((a, b) => b[1].area - a[1].area);
  if (!roots.length) throw new Error('No colors detected.');

  const maskBuffers = new Map<number, Buffer>();
  for (const [root] of roots) {
    maskBuffers.set(root, Buffer.alloc(totalPixels));
  }
  for (let i = 0; i < totalPixels; i += 1) {
    const c = labels[i];
    if (removed.has(c)) continue;
    const root = find(c);
    const buf = maskBuffers.get(root);
    if (!buf) continue;
    buf[i] = 255;
  }

  const layers = await Promise.all(
    roots.map(async ([root, info], idx) => {
      const maskRaw = maskBuffers.get(root)!;
      const maskPngBuffer = await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
      const maskDataUrl = `data:image/png;base64,${maskPngBuffer.toString('base64')}`;
      const meanR = info.sumRgb[0] / Math.max(info.area, 1);
      const meanG = info.sumRgb[1] / Math.max(info.area, 1);
      const meanB = info.sumRgb[2] / Math.max(info.area, 1);
      return {
        id: `color-${idx + 1}`,
        maskDataUrl,
        avgColor: rgbToHex(meanR, meanG, meanB),
        areaPct: info.area / totalPixels,
      };
    })
  );

  return { width, height, layers };
}

async function saveDesign(data: {
  title?: string;
  name?: string;
  prompt: string;
  userId: string;
  style: StyleKey;
  resolution: number;
  views: ViewKey[];
  composite: string;
  images: { view: string; src: string }[];
}) {
  const validation = validateDesignPayload({
    ...data,
    name: data.name,
    userId: data.userId,
    composite: data.composite,
    images: data.images,
  });

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const compositeFileId = await uploadDataUrlToGridFS(data.composite, `composite-${Date.now()}.png`);
  const imageFileIds = await Promise.all(
    data.images.map((img: { view: string; src: string }, idx: number) =>
      uploadDataUrlToGridFS(img.src, `${img.view || idx}-${Date.now()}.png`)
    )
  );

  const doc = await Design.create({
    ...validation.data,
    name: validation.data.name,
    title: validation.data.name,
    composite: { mime: 'image/png', fileId: compositeFileId.toString() },
    images: data.images.map((img: { view: string; src: string }, idx: number) => ({
      view: img.view,
      mime: 'image/png',
      fileId: imageFileIds[idx].toString(),
    })),
  });
  return doc._id.toString();
}

function computeGrid(n: number): { columns: number; rows: number } {
  if (n <= 0) {
    throw new Error('View count must be at least 1');
  }

  const presets: Record<number, { columns: number; rows: number }> = {
    1: { columns: 1, rows: 1 },
    2: { columns: 2, rows: 1 },
    3: { columns: 3, rows: 1 },
    4: { columns: 2, rows: 2 },
    5: { columns: 3, rows: 2 },
    6: { columns: 3, rows: 2 },
  };

  const preset = presets[n];
  if (preset) return preset;

  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  return { columns, rows };
}

const viewSpecificInstructions: Record<ViewKey, string> = {
  front: 'STRICT: Front view (head-on). Subject faces the camera. Show the front-facing side only.',
  back: 'STRICT: Back view (rear). Subject faces away from the camera. Show the back-facing side only (no front).',
  left: [
    "STRICT: Left side view (subject's LEFT).",
    "Camera is on the subject's LEFT side.",
    'The subject should be facing RIGHT in the frame (front points to the RIGHT side of the image).',
    "Show the LEFT side only; do NOT show the subject's RIGHT side.",
  ].join(' '),
  right: [
    "STRICT: Right side view (subject's RIGHT).",
    "Camera is on the subject's RIGHT side.",
    'The subject should be facing LEFT in the frame (front points to the LEFT side of the image).',
    "Show the RIGHT side only; do NOT show the subject's LEFT side.",
  ].join(' '),
  threeQuarter: [
    'STRICT: Three-quarter view from FRONT-RIGHT.',
    "Camera sees the front and the subject's RIGHT side at the same time.",
    'The subject is turned slightly LEFT (front points slightly LEFT).',
  ].join(' '),
  closeUp: [
    'STRICT: Close-up view of the same product/design.',
    'Camera is closer and zoomed in to show design details (logos, patterns, texture) clearly.',
    'Keep the product centered; do NOT add frames, boxes, borders, or background patterns.',
    'Do not crop important design elements; keep main chest/logo area fully visible.',
  ].join(' '),
  top: 'STRICT: Top-down overhead view. Camera directly above. Show the top view only.',
};

function buildViewPrompt(basePrompt: string, style: StyleKey, view: ViewKey, width: number, height: number) {
  return [
    `Single-frame image of the SAME product/design viewed from the ${viewLabels[view]} angle.`,
    `View requirement: ${viewSpecificInstructions[view]}`,
    `No grids, no collages, no multi-panel layouts. One centered subject.`,
    FULL_FRAME_POSITIVE_PROMPT,
    FULL_FRAME_NEGATIVE_PROMPT,
    'Consistency: keep the same zoom level, padding, and camera distance across all requested views.',
    `Keep lighting, materials, and colors identical to every other view.`,
    `Do not mirror or flip the subject. Do not swap left/right. Each requested view must be distinct and match its angle.`,
    WHITE_BACKGROUND_PROMPT,
    NO_SHADOWS_PROMPT,
    `Style: ${styleModifiers[style]}.`,
    `Base prompt: ${basePrompt}`,
    `Target output size close to ${width}x${height}px (square crop friendly).`,
  ].join(' ');
}

function buildBasePrompt(prompt: string, style: StyleKey, resolution: number, forceWhiteOverride?: boolean) {
  const forceWhite =
    typeof forceWhiteOverride === 'boolean' ? forceWhiteOverride : shouldForceWhiteBackgroundFromPrompt(prompt);
  return [
    'Generate ONE base image that matches the user prompt.',
    'STRICT: Front view (head-on) unless the user prompt implies a different viewpoint (e.g. poster/logo).',
    'STRICT: Do not add socks, shoes, mannequins, models, people, faces, hands, or body parts unless the user prompt explicitly asks for them.',
    'No grids, no collages, no multi-panel layouts.',
    FULL_FRAME_POSITIVE_PROMPT,
    FULL_FRAME_NEGATIVE_PROMPT,
    NO_SHADOWS_PROMPT,
    forceWhite ? WHITE_BACKGROUND_PROMPT : null,
    `Style: ${styleModifiers[style]}.`,
    `User prompt: ${prompt}`,
    `Target output size close to ${resolution}x${resolution}px (square).`,
  ].join(' ');
}

function buildViewFromBasePrompt(
  style: StyleKey,
  view: ViewKey,
  width: number,
  height: number,
  userPrompt?: string,
  extraInstruction?: string,
  forceWhiteOverride?: boolean,
) {
  const sideStrict =
    view === 'left'
      ? 'Generate the LEFT SIDE view (camera positioned on the left side of the subject/object). Maintain exact same design. Do not mirror or change design. Only change camera angle.'
      : view === 'right'
        ? 'Generate the RIGHT SIDE view (camera positioned on the right side of the subject/object). Maintain exact same design. Do not mirror or reuse left side. Only change camera angle. Ensure it is clearly the right side view.'
        : null;
  const forceWhite =
    typeof forceWhiteOverride === 'boolean'
      ? forceWhiteOverride
      : shouldForceWhiteBackgroundFromPrompt(userPrompt || '');

  return [
    `Create a single image of the SAME design from the ${viewLabels[view]} angle.`,
    `View requirement: ${viewSpecificInstructions[view]}`,
    sideStrict,
    extraInstruction?.trim() ? `IMPORTANT: ${extraInstruction.trim()}` : null,
    'Use this exact design. Do not change the main subject identity, colors, patterns, or layout. Only change camera angle.',
    FULL_FRAME_POSITIVE_PROMPT,
    FULL_FRAME_NEGATIVE_PROMPT,
    'Consistency: keep the same zoom level, padding, and camera distance across all requested views.',
    'STRICT: Do not add socks, shoes, mannequins, models, people, faces, hands, or body parts unless the user prompt explicitly asks for them.',
    userPrompt?.trim()
      ? `User prompt (secondary reference): ${userPrompt.trim()}. The attached base image is the ground-truth design reference.`
      : null,
    NO_SHADOWS_PROMPT,
    forceWhite ? WHITE_BACKGROUND_PROMPT : null,
    'No grids, no collages, no multi-panel layouts. One centered subject.',
    'Do not mirror or flip the subject. Do not swap left/right.',
    `Style: ${styleModifiers[style]}.`,
    `Target output size close to ${width}x${height}px (square crop friendly).`,
  ].join(' ');
}

function buildStyleConversionPrompt(style: StyleKey) {
  if (style === 'lineart') {
    // NOTE: This prompt is intentionally strict and should remain stable, since downstream validation relies on it.
    return (
      'Convert to CLEAN outline-only fashion flat technical drawing (tech pack / apparel CAD). ' +
      'White background ONLY (pure #FFFFFF). Thin solid black continuous vector outline strokes ONLY. ' +
      'DO NOT fill any areas black. DO NOT produce silhouettes or stencils. Keep shirt and shorts interior WHITE (empty). ' +
      'NO shading, NO gradients, NO textures, NO folds, NO shadows. NO sketching, NO hatching, NO stipple, NO halftone. ' +
      'NO dotted/broken lines. NO dashed lines. NO stitching marks. NO perforations. NO paper grain. ' +
      'NO frames, NO borders, NO boxes, NO mockups, NO devices, NO rounded-rectangle panels. ' +
      'Keep the same design details and proportions, but represent them as clean technical outlines only.'
    );
  }

  return [
    'Convert style only, keep design identical.',
    'Do not change colors, patterns, logos, text, placement, or branding.',
    `Target style: ${styleModifiers[style]}.`,
    'Keep composition and camera angle the same as the input image.',
  ].join(' ');
}

function buildMannequinConversionPrompt(modelKey: MannequinModelKey) {
  return [
    `Generate a high-resolution PHOTOREALISTIC studio photograph of a real ${modelKey} human athlete wearing the exact same soccer uniform from the reference image.`,
    'STRICT: REAL human athlete (NOT mannequin, NOT doll, NOT statue, NOT dummy).',
    'STRICT: REAL CAMERA PHOTO. Professional ecommerce studio photography. Natural skin texture and realistic facial details.',
    'STRICT CAMERA FRAMING: FULL BODY including head and face. Head-to-toe. Wide full-body photo. Centered subject. Leave generous margin above head and below feet. Do NOT crop.',
    FULL_FRAME_POSITIVE_PROMPT,
    FULL_FRAME_NEGATIVE_PROMPT,
    'STRICT: NOT 3D render. NOT CGI. NOT illustration. NOT stylized. NOT line art. NOT watercolor.',
    'STRICT: Preserve the exact uniform design and all details: colors, patterns, logos, text, placement, numbering, and branding.',
    'STRICT: Keep the same camera angle and view as the input image (front stays front; back stays back; left stays left; right stays right).',
    'STRICT: Do not invent new design elements. Do not mirror or flip.',
    'STRICT: Do not add socks, shoes, gloves, hats, or accessories unless they are clearly present in the input image.',
    'Background: clean white or very light gray studio backdrop (no gradients, no heavy shadows).',
  ].join(' ');
}

function modelFrontPrompt(modelKey: MannequinModelKey, extraConstraints?: string) {
  return [
    `Generate a high-resolution PHOTOREALISTIC studio photograph of a real adult ${modelKey} model wearing the exact same garment/apparel product from the reference image.`,
    'VIEW: FRONT view. Keep the same orientation as the input.',
    'STRICT: REAL human athlete (NOT mannequin, NOT doll, NOT statue, NOT dummy).',
    'STRICT: REAL CAMERA PHOTO. Professional studio fashion photography (NOT 3D, NOT CGI).',
    'REALISM: natural skin microtexture, pores, fine hair strands, subtle imperfections. Avoid overly smooth/plastic skin.',
    'STRICT CAMERA FRAMING: FULL BODY head-to-toe including head and face. Wide full-body photo.',
    'Leave clear margin above the head and below the feet. Do NOT crop any body part or any clothing.',
    'STRICT: Do NOT zoom in. Use a consistent wide camera distance.',
    'STRICT: Preserve the exact garment design and all details: colors, patterns, logos/prints/text, placement, and branding.',
    'STRICT: Do not invent new design elements. Do not mirror or flip.',
    'Avoid adding extra accessories (hats, gloves, bags, jewelry) unless clearly present in the reference image.',
    extraConstraints?.trim() ? `IMPORTANT: ${extraConstraints.trim()}` : null,
    'Background: clean studio backdrop with even lighting. Do not let background choices override garment preservation.',
  ].join(' ');
}

function modelBackPrompt(modelKey: MannequinModelKey, extraConstraints?: string) {
  return [
    `Generate a high-resolution PHOTOREALISTIC studio photograph of a real adult ${modelKey} model wearing the exact same garment/apparel product from the reference image.`,
    'VIEW: BACK view (rear view). Keep the same orientation as the input.',
    'CRITICAL: Match the SAME camera distance and framing as the front view output (wide full-body).',
    'STRICT: REAL human athlete (NOT mannequin, NOT doll, NOT statue, NOT dummy).',
    'STRICT: REAL CAMERA PHOTO. Professional studio fashion photography (NOT 3D, NOT CGI).',
    'REALISM: natural skin microtexture, pores, fine hair strands, subtle imperfections. Avoid overly smooth/plastic skin.',
    'STRICT CAMERA FRAMING (NO EXCEPTIONS): FULL BODY head-to-toe including head and face. Wide full-body photo.',
    'Leave clear margin above the head and below the feet (extra padding).',
    'STRICT: Do NOT crop. Do NOT zoom. Do NOT use a close-up. Do NOT change focal length to crop the subject.',
    'STRICT: Preserve the exact garment design and all details: colors, patterns, logos/prints/text, placement, and branding.',
    'STRICT: Do not invent new design elements. Do not mirror or flip.',
    'Avoid adding extra accessories (hats, gloves, bags, jewelry) unless clearly present in the reference image.',
    extraConstraints?.trim() ? `IMPORTANT: ${extraConstraints.trim()}` : null,
    'Background: clean studio backdrop with even lighting. Do not let background choices override garment preservation.',
  ].join(' ');
}

function modelFrontPromptMaleFrom3d() {
  return [
    'Generate a high-resolution PHOTOREALISTIC full-body studio sports photograph of a real adult male athlete wearing the exact same soccer uniform from the reference image.',
    'VIEW: FRONT view. Neutral stance, arms relaxed at sides, kit clearly visible.',
    'CAMERA: REAL DSLR photo, 85mm look, crisp focus, high dynamic range, natural softbox lighting, subtle realistic shadows.',
    'REALISM DETAILS: visible skin pores and natural microtexture, subtle imperfections, realistic hair, natural facial features, correct human proportions.',
    'STRICT CAMERA FRAMING: FULL BODY head-to-toe including head/face. Wide full-body fashion photo. Centered subject. Leave generous margin above head and below feet. DO NOT crop.',
    'STRICT: NO 3D render. NO CGI. NO game character. NO cartoon. NO mannequin. NO plastic skin. NO doll.',
    'STRICT: Preserve the exact uniform design and all details: colors, patterns, logos, text, placement, numbering, and branding.',
    'STRICT: Do not invent design elements. Do not mirror or flip.',
    'STRICT: Do not add socks/shoes/accessories unless clearly present in the reference image.',
    'BACKGROUND: clean seamless white studio. Output should look like professional sports ecommerce photography.',
  ].join(' ');
}

function modelBackPromptMaleFrom3d() {
  return [
    'Generate a high-resolution PHOTOREALISTIC full-body studio sports photograph of a real adult male athlete wearing the exact same soccer uniform from the reference image.',
    'VIEW: BACK view (rear). Neutral stance, kit clearly visible.',
    'CAMERA: REAL DSLR photo, 85mm look, crisp focus, high dynamic range, natural softbox lighting, subtle realistic shadows.',
    'REALISM DETAILS: visible skin pores and natural microtexture, subtle imperfections, realistic hair, natural facial features, correct human proportions.',
    'CRITICAL: Match the SAME camera distance and framing as the front view output (wide full-body).',
    'STRICT CAMERA FRAMING: FULL BODY head-to-toe including head/face. Centered subject. Leave generous margin above head and below feet. DO NOT crop. DO NOT zoom.',
    'STRICT: NO 3D render. NO CGI. NO game character. NO cartoon. NO mannequin. NO plastic skin. NO doll.',
    'STRICT: Preserve the exact uniform design and all details: colors, patterns, logos, text, placement, numbering, and branding.',
    'STRICT: Do not invent design elements. Do not mirror or flip.',
    'STRICT: Do not add socks/shoes/accessories unless clearly present in the reference image.',
    'BACKGROUND: clean seamless white studio. Output should look like professional sports ecommerce photography.',
  ].join(' ');
}

function buildUniformFrontPrompt(userPrompt: string, resolution: number) {
  return [
    'Generate a 3D render of a sports uniform consisting ONLY of a shirt and shorts.',
    'STRICT: Do not add socks, shoes, gloves, hats, mannequins, people, or any body parts unless the user prompt explicitly asks for them.',
    'STRICT: No mannequin, no model, no person, no body, no legs, no feet unless explicitly requested.',
    'STRICT: Front view (head-on).',
    'Keep the entire uniform visible with comfortable margins (no cropping).',
    'No grids, no collages, no multi-panel layouts. Single centered product.',
    'Background: clean studio backdrop.',
    `Style: ${styleModifiers['3d']}.`,
    `User prompt: ${userPrompt}`,
    `Target output size close to ${resolution}x${resolution}px (square).`,
  ].join(' ');
}

function buildUniformBackPrompt(userPrompt: string, resolution: number) {
  return [
    'Generate the BACK view of the SAME sports uniform consisting ONLY of a shirt and shorts.',
    'Use the provided FRONT image as the exact design reference.',
    'STRICT: Back view (rear).',
    'STRICT: Maintain the exact same design (colors, patterns, logos, text, placement, and branding).',
    'STRICT: Do not mirror. Do not invent new details. Only change camera angle to back view.',
    'STRICT: Do not add socks, shoes, mannequins, people, or body parts unless the user prompt explicitly asks for them.',
    'No grids, no collages, no multi-panel layouts. Single centered product.',
    'Background: clean studio backdrop.',
    `Style: ${styleModifiers['3d']}.`,
    `User prompt: ${userPrompt}`,
    `Target output size close to ${resolution}x${resolution}px (square).`,
  ].join(' ');
}

function buildStyleConversionPromptForUniform(style: StyleKey) {
  // Reuse strict line-art rules, otherwise preserve design and angle.
  return buildStyleConversionPrompt(style);
}

async function postProcessLineArtPngBase64(pngBase64: string, targetSize?: number) {
  // Deterministic line-art conversion (no AI, no re-framing).
  // Goal: produce clean outlines while keeping the original framing/size.
  //
  // Approach (simple + robust):
  // - Flatten to white, denoise lightly.
  // - Blur strongly.
  // - Take per-pixel RGB absolute difference (edge strength) between denoised and blurred.
  //   This captures both shape edges and color-panel seams even if luminance is similar.
  // - Adaptive threshold so we don't return "almost blank" images.
  const raw = Buffer.from(normalizePngBase64(pngBase64), 'base64');
  const background = { r: 255, g: 255, b: 255, alpha: 1 };
  const base = sharp(raw, { failOn: 'none' }).ensureAlpha().flatten({ background });
  const sized =
    typeof targetSize === 'number' && Number.isFinite(targetSize) && targetSize > 0
      ? base.resize(targetSize, targetSize, { fit: 'contain', background, withoutEnlargement: true })
      : base;

  const denoise = sized.normalize().median(3).removeAlpha();

  const { data: baseRgb, info } = await denoise.raw().toBuffer({ resolveWithObject: true });
  const { data: blurRgb } = await denoise.blur(2.2).raw().toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  if (!width || !height) throw new Error('Line art postprocess: missing dimensions.');

  const pixelCount = width * height;
  const diff = new Uint8Array(pixelCount);
  let diffMax = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const off = i * 3;
    const dr = Math.abs((baseRgb[off] ?? 0) - (blurRgb[off] ?? 0));
    const dg = Math.abs((baseRgb[off + 1] ?? 0) - (blurRgb[off + 1] ?? 0));
    const db = Math.abs((baseRgb[off + 2] ?? 0) - (blurRgb[off + 2] ?? 0));
    const v = Math.max(dr, dg, db);
    diff[i] = v;
    if (v > diffMax) diffMax = v;
  }

  const samples: number[] = [];
  const sampleTarget = 4096;
  const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / sampleTarget)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      samples.push(diff[y * width + x] ?? 0);
    }
  }
  samples.sort((a, b) => a - b);
  const pct = (q: number) => {
    if (!samples.length) return 0;
    const pos = Math.max(0, Math.min(samples.length - 1, Math.floor(q * (samples.length - 1))));
    return samples[pos] ?? 0;
  };

  // Start with a conservative threshold and relax if too few edges.
  let threshold = Math.max(10, Math.min(80, Math.max(pct(0.9) * 0.85, pct(0.85), diffMax * 0.18)));
  const minInkPixels = Math.max(400, Math.floor(pixelCount / 1400)); // ~0.07% for 1024^2
  const maxInkPixels = Math.floor(pixelCount * 0.06); // if we exceed this, we are capturing texture/noise

  const buildMask = (t: number) => {
    const mask = new Uint8Array(pixelCount);
    let count = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      if ((diff[i] ?? 0) >= t) {
        mask[i] = 1;
        count += 1;
      }
    }
    return { mask, count };
  };

  let res = buildMask(threshold);
  for (let attempt = 0; attempt < 6 && res.count < minInkPixels; attempt += 1) {
    threshold = Math.max(4, threshold * 0.75);
    res = buildMask(threshold);
  }
  for (let attempt = 0; attempt < 4 && res.count > maxInkPixels; attempt += 1) {
    threshold = Math.min(140, threshold * 1.25);
    res = buildMask(threshold);
  }

  const idx = (x: number, y: number) => y * width + x;
  const keep = res.mask;

  // Morphological closing (dilate then erode) with a cross kernel to connect small gaps without over-thickening.
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const k = idx(x, y);
      if (keep[k]) {
        dilated[k] = 1;
        continue;
      }
      if (x > 0 && keep[idx(x - 1, y)]) {
        dilated[k] = 1;
        continue;
      }
      if (x + 1 < width && keep[idx(x + 1, y)]) {
        dilated[k] = 1;
        continue;
      }
      if (y > 0 && keep[idx(x, y - 1)]) {
        dilated[k] = 1;
        continue;
      }
      if (y + 1 < height && keep[idx(x, y + 1)]) {
        dilated[k] = 1;
        continue;
      }
      dilated[k] = 0;
    }
  }

  const closed = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const k = idx(x, y);
      if (!dilated[k]) {
        closed[k] = 0;
        continue;
      }
      const left = x > 0 ? dilated[idx(x - 1, y)] : 1;
      const right = x + 1 < width ? dilated[idx(x + 1, y)] : 1;
      const up = y > 0 ? dilated[idx(x, y - 1)] : 1;
      const down = y + 1 < height ? dilated[idx(x, y + 1)] : 1;
      closed[k] = left && right && up && down ? 1 : 0;
    }
  }

  const removeIsolatedInk = (mask: Uint8Array) => {
    const next = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const k = idx(x, y);
        if (!mask[k]) continue;
        let neighbors = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          const yy = y + ky;
          if (yy < 0 || yy >= height) continue;
          for (let kx = -1; kx <= 1; kx += 1) {
            const xx = x + kx;
            if (xx < 0 || xx >= width) continue;
            if (kx === 0 && ky === 0) continue;
            if (mask[idx(xx, yy)]) neighbors += 1;
          }
        }
        if (neighbors >= 1) next[k] = 1;
      }
    }
    return next;
  };

  let cleanedMask = removeIsolatedInk(closed);

  // Convert any thick/filled regions into contour lines to avoid "black blobs" on logos/text.
  // Boundary extraction: keep ink pixels that touch background (4-neighborhood).
  const boundary = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const k = row + x;
      if (!cleanedMask[k]) continue;
      if (
        !cleanedMask[k - 1] ||
        !cleanedMask[k + 1] ||
        !cleanedMask[k - width] ||
        !cleanedMask[k + width]
      ) {
        boundary[k] = 1;
      }
    }
  }
  cleanedMask = removeIsolatedInk(boundary);

  const out = Buffer.alloc(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = cleanedMask[i] ? 0 : 255;

  // Cleanup: remove single-pixel speckles/background grain while keeping solid continuous outlines.
  // Blur+threshold wipes isolated dots but preserves longer strokes.
  const png = await sharp(out, { raw: { width, height, channels: 1 } })
    .median(1)
    .png()
    .toBuffer();

  // Final pass to remove any remaining borders/rules introduced by the model.
  let outB64 = png.toString('base64');
  outB64 = await stripLineArtBorderLines(outB64, 18);
  outB64 = await stripLineArtHorizontalRules(outB64);
  outB64 = await stripLineArtFullWidthRulesOutsideInk(outB64);
  return outB64;
}

async function cleanupLineArtOutputToTarget(pngBase64: string, target: { width: number; height: number }) {
  const normalized = normalizePngBase64(pngBase64);
  const background = { r: 255, g: 255, b: 255, alpha: 1 };

  const crisp = await sharp(Buffer.from(normalized, 'base64'), { failOn: 'none' })
    .ensureAlpha()
    .flatten({ background })
    .grayscale()
    .median(1)
    .threshold(235)
    .png()
    .toBuffer();

  let out = crisp.toString('base64');
  out = await stripLineArtBorderLines(out, 20);
  out = await stripLineArtHorizontalRules(out);
  out = await stripLineArtFullWidthRulesOutsideInk(out);

  out = await resizeToMatch(out, target, WHITE_BG);
  out = await ensureSolidWhiteBackgroundPngBase64(out);
  return out;
}

async function sampleLumaStats(pngBase64: string, sampleSize = 64) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const { data } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .resize(sampleSize, sampleSize, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let dark = 0;
  let bright = 0;
  let min = 255;
  let max = 0;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
    if (v <= 20) dark += 1;
    if (v >= 235) bright += 1;
  }
  const total = data.length || 1;
  return { darkRatio: dark / total, brightRatio: bright / total, min, max };
}

async function validateLineArtPngBase64OrThrow(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  if (!normalized) throw new Error('Empty image base64.');
  const buf = Buffer.from(normalized, 'base64');
  if (!buf.length) throw new Error('Converted image too small/corrupt.');

  const img = sharp(buf, { failOn: 'none' }).ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255 } });
  const meta = await img.metadata();
  if (!meta?.width || !meta?.height) throw new Error('Converted image missing dimensions.');
  if (meta.width < 32 || meta.height < 32) throw new Error('Converted image dimensions too small.');
  if (meta.format && !['png', 'jpeg', 'jpg', 'webp'].includes(String(meta.format).toLowerCase())) {
    throw new Error(`Unsupported converted image format: ${String(meta.format)}`);
  }

  const sample = await sampleLumaStats(normalized);
  if (sample.max <= 10 || sample.darkRatio >= 0.9) throw new Error('Converted line art appears fully black.');
  if (sample.min >= 245 || sample.brightRatio >= 0.98) throw new Error('Converted line art appears blank/white.');
  if (sample.darkRatio > 0.55) throw new Error('Converted line art appears filled/silhouette (too much black).');
  if (sample.brightRatio <= 0.35) throw new Error('Converted line art background is not white.');
}

async function detectMostlyBlackSilhouette(pngBase64: string) {
  const sample = await sampleLumaStats(pngBase64);
  return sample.darkRatio > 0.55;
}

async function validateLineArtOutput(pngBase64: string) {
  await validateLineArtPngBase64OrThrow(pngBase64);
  if (await detectMostlyBlackSilhouette(pngBase64)) {
    throw new Error('Converted line art detected as a filled silhouette (mostly black).');
  }

  // Reject "dirty" outputs (paper grain / halftone / stipple) by checking how much ink exists near the edges.
  // Good line art should be mostly empty in the border area.
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .grayscale()
    .resize(256, 256, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  if (!width || !height) return;
  const margin = Math.max(8, Math.floor(Math.min(width, height) * 0.08));
  let borderDark = 0;
  let borderTotal = 0;
  const darkThreshold = 175;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBorder = x < margin || y < margin || x >= width - margin || y >= height - margin;
      if (!inBorder) continue;
      borderTotal += 1;
      if (data[y * width + x] <= darkThreshold) borderDark += 1;
    }
  }
  const borderDarkRatio = borderDark / Math.max(1, borderTotal);
  if (borderDarkRatio > 0.02) {
    throw new Error('Converted line art contains background speckle/noise (dirty border).');
  }
}

async function fallbackLineArtEdgeDetectPngBase64(pngBase64: string) {
  const normalized = normalizePngBase64(pngBase64);
  const buf = Buffer.from(normalized, 'base64');

  const { data, info } = await sharp(buf, { failOn: 'none' })
    .ensureAlpha()
    .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  if (!width || !height) throw new Error('Fallback edge detect: missing dimensions.');

  const gray = new Uint8Array(data);
  const blurred = new Float32Array(gray.length);
  const gaussian = [1, 2, 1, 2, 4, 2, 1, 2, 1];

  const idx = (x: number, y: number) => y * width + x;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let acc = 0;
      let k = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          acc += gray[idx(x + kx, y + ky)] * gaussian[k];
          k += 1;
        }
      }
      blurred[idx(x, y)] = acc / 16;
    }
  }

  const mag = new Float32Array(gray.length);
  let sumMag = 0;
  let maxMag = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const a00 = blurred[idx(x - 1, y - 1)];
      const a10 = blurred[idx(x, y - 1)];
      const a20 = blurred[idx(x + 1, y - 1)];
      const a01 = blurred[idx(x - 1, y)];
      const a21 = blurred[idx(x + 1, y)];
      const a02 = blurred[idx(x - 1, y + 1)];
      const a12 = blurred[idx(x, y + 1)];
      const a22 = blurred[idx(x + 1, y + 1)];

      const gx = -a00 + a20 - 2 * a01 + 2 * a21 - a02 + a22;
      const gy = a00 + 2 * a10 + a20 - a02 - 2 * a12 - a22;
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[idx(x, y)] = m;
      sumMag += m;
      if (m > maxMag) maxMag = m;
    }
  }

  const avgMag = sumMag / Math.max(1, (width - 2) * (height - 2));
  const threshold = Math.max(25, Math.min(140, avgMag * 2.2));

  const out = Buffer.alloc(gray.length);
  for (let i = 0; i < mag.length; i += 1) {
    out[i] = mag[i] > threshold ? 0 : 255;
  }

  const png = await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
  // Already strict monochrome outlines on white (0/255).
  return png.toString('base64');
}

function buildUniformCompositePrompt({
  userPrompt,
  style,
  views,
  columns,
  rows,
  resolution,
}: {
  userPrompt: string;
  style: StyleKey;
  views: UniformViewKey[];
  columns: number;
  rows: number;
  resolution: number;
}) {
  const viewToCell = views.map((view, idx) => {
    const col = (idx % columns) + 1;
    const row = Math.floor(idx / columns) + 1;
    const strictInstruction = viewSpecificInstructions[view as ViewKey];
    return `Cell ${idx + 1} (row ${row}, col ${col}): ${view.toUpperCase()} view. ${strictInstruction}`;
  });

  return [
    `Generate ONE single composite image arranged as a grid with ${rows} row(s) and ${columns} column(s).`,
    'Each grid cell is one view. Keep the layout rigid and evenly spaced.',
    'STRICT: Do NOT add labels, text, captions, borders, or panel dividers. No watermarks.',
    'STRICT: The composite must contain ONLY the requested views and nothing else.',
    'Generate a sports uniform consisting ONLY of a shirt and shorts.',
    'STRICT: Do not add socks, shoes, mannequins, people, or body parts unless the user prompt explicitly asks for them.',
    'STRICT: Use this exact design across all views; do not change colors, patterns, logos, text, placement, or branding.',
    'STRICT: Do not mirror or flip. Left must be left, right must be right.',
    `Rendering style: ${styleModifiers[style]}.`,
    ...viewToCell,
    `User prompt: ${userPrompt}`,
    `Target output size exactly ${resolution}x${resolution}px (square).`,
  ].join(' ');
}

function computeSlices(total: number, parts: number) {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  const sizes = Array.from({ length: parts }, (_v, idx) => base + (idx < remainder ? 1 : 0));
  const offsets: number[] = [];
  let acc = 0;
  for (const s of sizes) {
    offsets.push(acc);
    acc += s;
  }
  return { sizes, offsets };
}

async function cropCompositeToTiles({
  compositePngBase64,
  resolution,
  views,
}: {
  compositePngBase64: string;
  resolution: number;
  views: UniformViewKey[];
}) {
  const grid = computeGrid(views.length);
  const { sizes: colSizes, offsets: colOffsets } = computeSlices(resolution, grid.columns);
  const { sizes: rowSizes, offsets: rowOffsets } = computeSlices(resolution, grid.rows);

  const compositeBuffer = await sharp(Buffer.from(normalizePngBase64(compositePngBase64), 'base64'))
    .ensureAlpha()
    .resize(resolution, resolution, { fit: 'fill' })
    .png()
    .toBuffer();

  const tiles = await Promise.all(
    views.map(async (view, idx) => {
      const col = idx % grid.columns;
      const row = Math.floor(idx / grid.columns);
      const left = colOffsets[col] ?? 0;
      const top = rowOffsets[row] ?? 0;
      const width = colSizes[col] ?? 1;
      const height = rowSizes[row] ?? 1;
      const tile = await sharp(compositeBuffer).extract({ left, top, width, height }).png().toBuffer();
      return { view, imageBase64: tile.toString('base64') };
    })
  );

  return {
    compositeBase64: compositeBuffer.toString('base64'),
    tiles,
    meta: {
      grid,
      resolution,
      views,
    },
  };
}

function buildCompositeStyleConversionPrompt(style: StyleKey) {
  if (style === 'lineart') {
    return [
      'Convert this composite grid image into clean black outline line-art on a pure white background.',
      'STRICT: Preserve the exact grid layout and panel positions. Do not move, resize, crop, add borders, or add labels.',
      'STRICT: Use ONLY solid black outlines. No gray. No blue. No shading. No gradients. No textures. No fill colors.',
      'Keep the same uniform design details, but represent them as minimal clean black outlines only.',
    ].join(' ');
  }

  return [
    'Convert this composite grid image to the target style.',
    'STRICT: Preserve the exact grid layout and panel positions. Do not move, resize, crop, add borders, or add labels.',
    'STRICT: Keep the uniform design identical (colors, patterns, logos, text, placement). Style change only.',
    `Target style: ${styleModifiers[style]}.`,
  ].join(' ');
}

function buildCompositeMannequinPrompt(modelKey: MannequinModelKey) {
  return [
    `Convert this composite grid image into a mannequin preview using a ${modelKey} mannequin.`,
    'STRICT: Preserve the exact grid layout and panel positions. Do not move, resize, crop, add borders, or add labels.',
    'STRICT: Keep the same uniform design, style, and colors.',
    'Photorealistic studio product photo (realistic).',
    'No extra views beyond the existing grid panels.',
  ].join(' ');
}

function normalizeIncomingStyleKey(raw: unknown): StyleKey | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  if (!normalized) return null;
  if (normalized === 'realistic') return 'realistic';
  if (normalized === 'watercolor') return 'watercolor';
  if (normalized === 'line_art' || normalized === 'lineart') return 'lineart';
  if (normalized === '3d' || normalized === '3d_render' || normalized === 'render_3d') return '3d';
  return null;
}

function normalizeIncomingViewKey(raw: unknown): ViewKey | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  const normalized = v.toLowerCase().replace(/[\s_-]+/g, '_');

  if (normalized === 'front') return 'front';
  if (normalized === 'back') return 'back';
  if (normalized === 'left') return 'left';
  if (normalized === 'right') return 'right';
  if (normalized === 'top') return 'top';

  if (normalized === 'three_quarter' || normalized === 'threequarter' || normalized === '3_4' || normalized === '3_4_view') {
    return 'threeQuarter';
  }
  if (normalized === 'close_up' || normalized === 'closeup' || normalized === 'close_up_view') {
    return 'closeUp';
  }

  return null;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>) {
  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

type ExportFormat = 'zip' | 'composite' | 'pdf';
type ExportItem = { name: string; imageBase64: string };
type ExportSession = { userId: string; format: ExportFormat; items: ExportItem[]; createdAt: number };
const exportSessions = new Map<string, ExportSession>();
const EXPORT_TTL_MS = 10 * 60 * 1000;

function cleanupExportSessions() {
  const now = Date.now();
  for (const [id, sess] of exportSessions.entries()) {
    if (now - sess.createdAt > EXPORT_TTL_MS) exportSessions.delete(id);
  }
}

async function buildCompositeGridPng(items: ExportItem[]) {
  if (!items.length) throw new Error('No items to export.');
  const buffers = items.map((it) => Buffer.from(normalizePngBase64(it.imageBase64), 'base64'));

  const metas = await Promise.all(buffers.map((buf) => sharp(buf).metadata().catch(() => null)));
  const tileSize = Math.max(
    256,
    Math.min(
      2048,
      Math.round(
        Number(metas.find((m) => m?.width && m?.width === m?.height)?.width) ||
        Number(metas.find((m) => m?.width)?.width) ||
        1024
      )
    )
  );

  const columns = 2;
  const rows = Math.ceil(items.length / columns);
  const background = { r: 255, g: 255, b: 255, alpha: 1 };

  const resized = await Promise.all(
    buffers.map((buf) => sharp(buf).resize(tileSize, tileSize, { fit: 'contain', background }).png().toBuffer())
  );

  const overlays = resized.map((buf, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    return { input: buf, left: col * tileSize, top: row * tileSize };
  });

  return await sharp({
    create: { width: columns * tileSize, height: rows * tileSize, channels: 4, background },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}

function extractGeminiInlineImagePart(response: any): { data: string; mimeType?: string } | null {
  const candidates = response?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : null;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return null;

  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (inlineData?.data) {
      return { data: String(inlineData.data), mimeType: inlineData.mimeType ?? inlineData.mime_type };
    }
  }

  return null;
}

function extractGeminiTextParts(response: any): string {
  const candidates = response?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : null;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p: any) => (typeof p?.text === 'string' ? p.text.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripNegativePromptLine(prompt: string): string {
  const s = String(prompt ?? '');
  return s.replace(/\n\s*Negative prompt:\s*[\s\S]*$/i, '').trim();
}

async function generateViewImage(
  prompt: string,
  style: StyleKey,
  view: ViewKey,
  targetWidth: number,
  targetHeight: number,
  options?: { background?: { r: number; g: number; b: number; alpha: number } }
) {
  const response = await generateContentWithRetry(
    `generateViewImage:${view}`,
    async () =>
      await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: buildViewPrompt(prompt, style, view, targetWidth, targetHeight),
      }),
    { attempts: 2, baseDelayMs: 350 }
  );

  const parts = (response as any)?.candidates?.[0]?.content?.parts;
  const imagePart = extractGeminiInlineImagePart(response);

  if (!imagePart?.data) {
    throw new Error(`Gemini response did not include an image for view "${view}".`);
  }

  const raw = Buffer.from(imagePart.data as string, 'base64');
  const background = options?.background ?? { r: 245, g: 246, b: 248, alpha: 1 };
  const insetScale = 0.9;
  const insetWidth = Math.max(1, Math.round(targetWidth * insetScale));
  const insetHeight = Math.max(1, Math.round(targetHeight * insetScale));
  const inset = await sharp(raw)
    .resize(insetWidth, insetHeight, { fit: 'contain', background, withoutEnlargement: true })
    .png()
    .toBuffer();

  const left = Math.floor((targetWidth - insetWidth) / 2);
  const top = Math.floor((targetHeight - insetHeight) / 2);
  const resized = await sharp({
    create: { width: targetWidth, height: targetHeight, channels: 4, background },
  })
    .composite([{ input: inset, left, top }])
    .png()
    .toBuffer();

  return {
    view,
    buffer: resized,
    dataUrl: `data:image/png;base64,${resized.toString('base64')}`,
  };
}

async function generateViewImageFromBase(
  baseImageBase64: string,
  style: StyleKey,
  view: ViewKey,
  targetWidth: number,
  targetHeight: number,
  userPrompt?: string,
  extraInstruction?: string,
  options?: { background?: { r: number; g: number; b: number; alpha: number }; forceWhiteOverride?: boolean }
) {
  const inlineData = pngBase64ToInlineData(baseImageBase64);
  const response = await generateContentWithRetry(
    `generateViewImageFromBase:${view}`,
    async () =>
      await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: buildViewFromBasePrompt(
                  style,
                  view,
                  targetWidth,
                  targetHeight,
                  userPrompt,
                  extraInstruction,
                  options?.forceWhiteOverride
                ),
              },
              { inlineData },
            ],
          },
        ],
      }),
    { attempts: 2, baseDelayMs: 500 }
  );

  const parts = (response as any)?.candidates?.[0]?.content?.parts;
  const imagePart = extractGeminiInlineImagePart(response);

  if (!imagePart?.data) {
    throw new Error(`Gemini response did not include an image for view "${view}".`);
  }

  const raw = Buffer.from(imagePart.data as string, 'base64');
  const background = options?.background ?? { r: 245, g: 246, b: 248, alpha: 1 };
  // IMPORTANT: do not intentionally shrink non-front views.
  // We always return an image that is exactly targetWidth × targetHeight,
  // and rely on prompt + post-processing for safe framing.
  const resized = await sharp(raw)
    .resize(targetWidth, targetHeight, { fit: 'contain', background })
    .png()
    .toBuffer();

  return {
    view,
    buffer: resized,
    dataUrl: `data:image/png;base64,${resized.toString('base64')}`,
  };
}

async function computeDHash64(buffer: Buffer): Promise<bigint> {
  const { data } = await sharp(buffer).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    const rowOffset = row * 9;
    for (let col = 0; col < 8; col += 1) {
      const left = data[rowOffset + col] ?? 0;
      const right = data[rowOffset + col + 1] ?? 0;
      if (left > right) {
        hash |= 1n << BigInt(row * 8 + col);
      }
    }
  }
  return hash;
}

function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

async function isLikelySameAngle(left: Buffer, right: Buffer): Promise<boolean> {
  const leftHash = await computeDHash64(left);
  const rightHash = await computeDHash64(right);
  const flippedLeft = await sharp(left).flop().png().toBuffer();
  const flippedLeftHash = await computeDHash64(flippedLeft);

  const distSame = hammingDistance64(leftHash, rightHash);
  const distFlip = hammingDistance64(flippedLeftHash, rightHash);

  // Orientation-based guard: if "right" is significantly closer to the LEFT image than to the mirrored-left,
  // it's very likely the same side view was reused (two lefts / two rights), even if not pixel-identical.
  if (distFlip >= distSame + 2 && distSame <= 28) return true;

  // Fallback: pixel similarity check (more forgiving to minor resampling/compression differences).
  const sample = async (buf: Buffer) => {
    const { data } = await sharp(buf)
      .ensureAlpha()
      .resize(64, 64, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };

  const [a, b, bFlip] = await Promise.all([sample(left), sample(right), sample(flippedLeft)]);
  const avgAbsDiff = (x: Buffer, y: Buffer) => {
    const n = Math.min(x.length, y.length) || 1;
    let acc = 0;
    for (let i = 0; i < n; i += 1) acc += Math.abs(x[i] - y[i]);
    return acc / n;
  };

  const diffSame = avgAbsDiff(a, b);
  const diffFlip = avgAbsDiff(bFlip, b);

  // If right is much closer to left than to flipped-left, it's likely the same side view reused.
  return diffSame <= 14 && diffFlip >= diffSame + 1;
}

async function isOppositeSideOfLeft(left: Buffer, right: Buffer): Promise<boolean> {
  const leftHash = await computeDHash64(left);
  const rightHash = await computeDHash64(right);
  const flippedLeft = await sharp(left).flop().png().toBuffer();
  const flippedLeftHash = await computeDHash64(flippedLeft);

  const distSame = hammingDistance64(leftHash, rightHash);
  const distFlip = hammingDistance64(flippedLeftHash, rightHash);

  // If the right view is closer to the mirrored-left than to the left, it is very likely the opposite side.
  if (distFlip + 1 < distSame) return true;

  // Pixel check as a secondary signal.
  const sample = async (buf: Buffer) => {
    const { data } = await sharp(buf)
      .ensureAlpha()
      .resize(64, 64, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };

  const [a, b, aFlip] = await Promise.all([sample(left), sample(right), sample(flippedLeft)]);
  const avgAbsDiff = (x: Buffer, y: Buffer) => {
    const n = Math.min(x.length, y.length) || 1;
    let acc = 0;
    for (let i = 0; i < n; i += 1) acc += Math.abs(x[i] - y[i]);
    return acc / n;
  };

  const diffSame = avgAbsDiff(a, b);
  const diffFlip = avgAbsDiff(aFlip, b);
  return diffFlip + 0.5 < diffSame;
}

async function composeComposite(
  tiles: { view: ViewKey; buffer: Buffer }[],
  columns: number,
  rows: number,
  tileWidth: number,
  tileHeight: number,
  options?: { background?: { r: number; g: number; b: number; alpha: number } }
) {
  const background = options?.background ?? { r: 245, g: 246, b: 248, alpha: 1 };
  const canvas = sharp({
    create: {
      width: columns * tileWidth,
      height: rows * tileHeight,
      channels: 4,
      background,
    },
  });

  const overlays = tiles.map((tile, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    return {
      input: tile.buffer,
      left: col * tileWidth,
      top: row * tileHeight,
    };
  });

  const compositeBuffer = await canvas.composite(overlays).png().toBuffer();

  return {
    dataUrl: `data:image/png;base64,${compositeBuffer.toString('base64')}`,
    buffer: compositeBuffer,
    dimensions: {
      width: columns * tileWidth,
      height: rows * tileHeight,
    },
  };
}

app.post('/api/generate-views', async (req: Request, res: Response) => {
  const { prompt, style, views, resolution, autoSave, title } = req.body as GenerateRequestBody;
  const userId = req.headers['x-user-id'] as string | undefined;

  if (!prompt || !prompt.trim()) {
    return safeJson(res, { error: 'Prompt is required.' }, 400);
  }

  if (!style || !(style in styleModifiers)) {
    return safeJson(res, { error: 'Invalid style. Allowed: realistic, 3d, lineart, watercolor.' }, 400);
  }

  if (!Array.isArray(views) || views.length < 1) {
    return safeJson(res, { error: 'At least one view must be selected.' }, 400);
  }

  const unknownView = views.find((v) => !(v in viewLabels));
  if (unknownView) {
    return safeJson(res, { error: `Invalid view: ${unknownView}` }, 400);
  }

  if (!resolution || !allowedResolutions.has(resolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }

  if (autoSave && (!userId || !userId.trim())) {
    return safeJson(res, { error: 'Missing user id' }, 401);
  }

  if (!process.env.GEMINI_API_KEY) {
    return safeJson(res, { error: 'GEMINI_API_KEY is not configured on the server.' }, 500);
  }

  try {
    const userPrompt = prompt.trim();
    const enhanceOptions = {
      creativity: Number((req.body as any)?.creativity ?? 0.3),
      modelFormat: deriveModelFormatFromEnv(),
      aspectRatio: '1:1' as const,
    };
    const { promptForModel } = maybeEnhancePrompt(userPrompt, enhanceOptions, 'generate-views');
    const grid = computeGrid(views.length);
    const tileWidth = Math.max(64, Math.floor(resolution / grid.columns));
    const tileHeight = Math.max(64, Math.floor(resolution / grid.rows));
    const sampleModelText = buildViewPrompt(promptForModel, style, views[0], tileWidth, tileHeight);
    assertPromptEnhancerSelectionDevOnly({ label: 'generate-views', userPrompt, promptForModel, modelText: sampleModelText });

    const tiles = await Promise.all(
      views.map((view) => generateViewImage(promptForModel, style, view, tileWidth, tileHeight))
    );

    const composite = await composeComposite(tiles, grid.columns, grid.rows, tileWidth, tileHeight);

    let designId: string | undefined;

    if (autoSave) {
      designId = await saveDesign(
        buildSaveDesignPayload({
          title,
          userId: userId!.trim(),
          prompt: userPrompt,
          style,
          resolution,
          views,
          composite: composite.dataUrl,
          images: tiles.map((tile) => ({ view: tile.view, src: tile.dataUrl })),
        }) as any
      );
    }

    return safeJson(
      res,
      buildGenerateViewsResponse({
        composite,
        tiles,
        grid,
        tileWidth,
        tileHeight,
        viewOrder: views,
        designId,
      })
    );
  } catch (err: any) {
    console.error('Gemini error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/generate-product-titles', async (req: Request, res: Response) => {
  try {
    const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
    const countRaw = Number(req.body?.count);
    const requestedCount = Number.isFinite(countRaw) ? Math.round(countRaw) : 120;
    const count = Math.min(120, Math.max(50, requestedCount));

    if (!productName) return safeJson(res, { error: 'productName is required.' }, 400);

    const batches = 2;
    const perBatch = Math.max(10, Math.ceil(count / batches));
    const all: string[] = [];

    for (let i = 0; i < batches; i += 1) {
      const prompt = buildTitlesPrompt({ productName, category: category || undefined, count: perBatch });
      const parsed = await generateTextJsonWithModelFallback<{ titles: unknown }>('generate-product-titles', prompt);

      const titlesRaw = normalizeLines(parsed?.titles, 180);
      const titles = titlesRaw
        .map((t) => trimDanglingTailWordsForTitle(trimIfLooksCutAtLimit(t, 120)))
        .filter((t) => t.length >= 60);
      all.push(...titles);
      await sleep(900);
    }

    const titles = uniqStable(all).slice(0, count);
    if (titles.length === 0) return safeJson(res, { error: 'Gemini returned no titles.' }, 502);
    return safeJson(res, { titles });
  } catch (err: any) {
    console.error('Generate product titles error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/generate-product-keywords', async (req: Request, res: Response) => {
  try {
    const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
    const countRaw = Number(req.body?.count);
    const requestedCount = Number.isFinite(countRaw) ? Math.round(countRaw) : 350;
    const count = Math.min(350, Math.max(100, requestedCount));

    if (!productName) return safeJson(res, { error: 'productName is required.' }, 400);

    const batches = 2;
    const perBatch = Math.max(50, Math.ceil(count / batches));
    const all: string[] = [];

    for (let i = 0; i < batches; i += 1) {
      const prompt = buildKeywordsPrompt({ productName, category: category || undefined, count: perBatch });
      const parsed = await generateTextJsonWithModelFallback<{ keywords: unknown }>('generate-product-keywords', prompt);

      const keywordsRaw = normalizeLines(parsed?.keywords, 120);
      const keywords = keywordsRaw.map((k) => trimIfLooksCutAtLimit(k, 60)).filter(Boolean);
      all.push(...keywords);
      await sleep(900);
    }

    const keywords = uniqStable(all).slice(0, count);
    if (keywords.length === 0) return safeJson(res, { error: 'Gemini returned no keywords.' }, 502);
    return safeJson(res, { keywords });
  } catch (err: any) {
    console.error('Generate product keywords error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/generate-base', async (req: Request, res: Response) => {
  const { prompt, resolution, width, height, referenceImageBase64, referenceImageMimeType } = req.body as GenerateBaseRequestBody;
  const style = normalizeIncomingStyleKey((req.body as any)?.style);
  const requestedResolution =
    Number.isFinite(Number(width)) && Number.isFinite(Number(height)) && Number(width) === Number(height) && Number(width) > 0
      ? Number(width)
      : resolution;

  if (!prompt || !prompt.trim()) {
    return safeJson(res, { error: 'Prompt is required.' }, 400);
  }

  if (!style || !(style in styleModifiers) || !allowedBaseStyles.has(style)) {
    return safeJson(res, { error: 'Invalid style. Allowed: realistic, 3d, lineart, watercolor.' }, 400);
  }

  if (!requestedResolution || !allowedResolutions.has(requestedResolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }

  try {
    const userPrompt = prompt.trim();
    const referenceInlineData = referenceImageBase64
      ? inlineDataFromAnyImageBase64({ base64: referenceImageBase64, mimeType: referenceImageMimeType })
      : null;
    const forceWhite = shouldForceWhiteBackgroundFromPrompt(userPrompt);
    const enhanceOptions = {
      creativity: Number((req.body as any)?.creativity ?? 0.3),
      modelFormat: deriveModelFormatFromEnv(),
      aspectRatio: inferAspectRatio(Number(width), Number(height)),
    };
    const { promptForModel } = maybeEnhancePrompt(userPrompt, enhanceOptions, 'generate-base');
    const modelTextPrimary = [
      buildBasePrompt(promptForModel, style, requestedResolution, forceWhite),
      referenceInlineData
        ? 'Reference image provided: use it as a visual design reference. Preserve the same design identity while generating the front view.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    assertPromptEnhancerSelectionDevOnly({ label: 'generate-base', userPrompt, promptForModel, modelText: modelTextPrimary });

    const promptForModelFallback = stripNegativePromptLine(promptForModel);
    const modelTextFallback = [
      buildBasePrompt(promptForModelFallback, style, requestedResolution, forceWhite),
      'IMPORTANT: Return an IMAGE only (no text).',
      referenceInlineData
        ? 'Reference image provided: use it as a visual design reference. Preserve the same design identity while generating the front view.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const callGemini = async (modelText: string) =>
      await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        // Hint to the API that we expect an image response.
        // (If unsupported, the SDK will ignore unknown config fields.)
        config: { responseModalities: ['IMAGE'] } as any,
        contents: [
          {
            role: 'user',
            parts: [
              ...(referenceInlineData ? [{ inlineData: referenceInlineData }] : []),
              { text: modelText },
            ],
          },
        ],
      });

    const primaryResponse = await generateContentWithRetry('generate-base', () => callGemini(modelTextPrimary), {
      attempts: 2,
      baseDelayMs: 450,
    });

    let imagePart = extractGeminiInlineImagePart(primaryResponse);
    if (!imagePart?.data) {
      const fallbackResponse = await generateContentWithRetry('generate-base:fallback', () => callGemini(modelTextFallback), {
        attempts: 2,
        baseDelayMs: 650,
      });
      imagePart = extractGeminiInlineImagePart(fallbackResponse);
      if (!imagePart?.data) {
        const text = extractGeminiTextParts(fallbackResponse) || extractGeminiTextParts(primaryResponse);
        throw new Error(`Gemini response did not include an image.${text ? ` Model said: ${text}` : ''}`);
      }
    }

    let baseImage = await normalizeGeminiOutputPngBase64(String(imagePart.data), requestedResolution, { background: WHITE_BG });
    if (forceWhite) {
      baseImage = await ensureSolidWhiteBackgroundStrict(baseImage);
    }
    return safeJson(res, { baseImage });
  } catch (err: any) {
    console.error('Generate base error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/generate-views-from-base', async (req: Request, res: Response) => {
  const { baseImageBase64, resolution, width, height, prompt } = req.body as GenerateViewsFromBaseRequestBody;
  const style = normalizeIncomingStyleKey((req.body as any)?.style);
  const viewsRaw = Array.isArray((req.body as any)?.views) ? (req.body as any).views : [];
  const views = viewsRaw
    .map((v: any) => normalizeIncomingViewKey(v))
    .filter((v: ViewKey | null): v is ViewKey => Boolean(v));
  const requestedResolution =
    Number.isFinite(Number(width)) && Number.isFinite(Number(height)) && Number(width) === Number(height) && Number(width) > 0
      ? Number(width)
      : resolution;

  if (!baseImageBase64 || typeof baseImageBase64 !== 'string') {
    return safeJson(res, { error: 'baseImageBase64 is required.' }, 400);
  }

  if (!style || !(style in styleModifiers) || !allowedBaseStyles.has(style)) {
    return safeJson(res, { error: 'Invalid style. Allowed: realistic, 3d, lineart, watercolor.' }, 400);
  }

  if (!views.length) {
    return safeJson(res, { error: 'At least one view must be selected.' }, 400);
  }

  // Ensure every incoming view is supported (normalized from UI labels/variants).
  const invalidView = viewsRaw.find((v: any) => !normalizeIncomingViewKey(v));
  if (invalidView) return safeJson(res, { error: `Invalid view: ${String(invalidView)}` }, 400);

  if (!requestedResolution || !allowedResolutions.has(requestedResolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }

  try {
    const userPrompt = (prompt || '').trim();
    const forceWhite = shouldForceWhiteBackgroundFromPrompt(userPrompt);
    const enhanceOptions = {
      creativity: Number((req.body as any)?.creativity ?? 0.3),
      modelFormat: deriveModelFormatFromEnv(),
      aspectRatio: inferAspectRatio(Number(width), Number(height)),
    };
    const { promptForModel } = userPrompt
      ? maybeEnhancePrompt(userPrompt, enhanceOptions, 'generate-views-from-base')
      : { promptForModel: userPrompt };
    if (userPrompt) {
      const sampleModelText = buildViewFromBasePrompt(
        style,
        views[0],
        requestedResolution,
        requestedResolution,
        promptForModel,
        undefined,
        forceWhite
      );
      assertPromptEnhancerSelectionDevOnly({
        label: 'generate-views-from-base',
        userPrompt,
        promptForModel,
        modelText: sampleModelText,
      });
    }
    const tileBackground = WHITE_BG;
    const grid = computeGrid(views.length);
    const tileWidth = Math.max(64, Math.floor(requestedResolution / grid.columns));
    const tileHeight = Math.max(64, Math.floor(requestedResolution / grid.rows));

    const normalizedBase = normalizePngBase64(baseImageBase64);
    const baseFullBuffer = await sharp(Buffer.from(normalizedBase, 'base64'))
      .resize(requestedResolution, requestedResolution, { fit: 'contain', background: tileBackground })
      .png()
      .toBuffer();

    // If both LEFT and RIGHT are requested, we generate LEFT and derive RIGHT by mirroring LEFT.
    // This guarantees a distinct right-side output even when the model keeps returning two left views.
    const generateRightFromLeft = views.includes('left') && views.includes('right');
    const viewsToGenerate = generateRightFromLeft ? views.filter((v) => v !== 'right') : views;

    const generatedMap = new Map<ViewKey, Buffer>();
    await Promise.all(
      viewsToGenerate.map(async (view) => {
        if (view === 'front') {
          if (!forceWhite) {
            generatedMap.set(view, baseFullBuffer);
            return;
          }
          const white = await ensureSolidWhiteBackgroundStrict(baseFullBuffer.toString('base64'));
          generatedMap.set(view, Buffer.from(white, 'base64'));
          return;
        }

        const generated = await generateViewImageFromBase(
          normalizedBase,
          style,
          view,
          requestedResolution,
          requestedResolution,
          promptForModel,
          undefined,
          { background: tileBackground, forceWhiteOverride: forceWhite }
        );
        const outBuf = forceWhite
          ? Buffer.from(await ensureSolidWhiteBackgroundStrict(generated.buffer.toString('base64')), 'base64')
          : generated.buffer;
        generatedMap.set(view, outBuf);
      })
    );

    if (generateRightFromLeft) {
      const leftBuf = generatedMap.get('left') ?? null;
      if (leftBuf) {
        const mirrored = await sharp(leftBuf).flop().png().toBuffer();
        const mirroredOut = forceWhite
          ? Buffer.from(await ensureSolidWhiteBackgroundStrict(mirrored.toString('base64')), 'base64')
          : mirrored;
        generatedMap.set('right', mirroredOut);
      }
    }

    const fullImages = views.map((view) => {
      const buf = generatedMap.get(view);
      if (!buf) throw new Error(`Missing generated view: ${view}`);
      return { view, buffer: buf };
    });

    if (views.includes('left') && views.includes('right')) {
      const leftTile = fullImages.find((t) => t.view === 'left') ?? null;
      const rightIdx = fullImages.findIndex((t) => t.view === 'right');

      if (leftTile && rightIdx !== -1) {
        const rightTile = fullImages[rightIdx];
        const shouldFix = rightTile && !(await isOppositeSideOfLeft(leftTile.buffer, rightTile.buffer));

        if (rightTile && shouldFix) {
          const regenerated = await generateViewImageFromBase(
            normalizedBase,
            style,
            'right',
            requestedResolution,
            requestedResolution,
            promptForModel,
            "This MUST be the RIGHT side view (opposite side from the LEFT). Do NOT reuse the left-side angle. Do NOT mirror the design. Only change camera angle. Ensure the garment's front points to the LEFT in the frame.",
            { background: tileBackground, forceWhiteOverride: forceWhite }
          );
          const outBuf = forceWhite
            ? Buffer.from(await ensureSolidWhiteBackgroundStrict(regenerated.buffer.toString('base64')), 'base64')
            : regenerated.buffer;

          // If Gemini still returned the left view again, fall back to a mirrored-left image
          // so the user always gets a distinct right-side view.
          const stillWrong = !(await isOppositeSideOfLeft(leftTile.buffer, outBuf));
          if (stillWrong) {
            const mirrored = await sharp(leftTile.buffer).flop().png().toBuffer();
            const mirroredOut = forceWhite
              ? Buffer.from(await ensureSolidWhiteBackgroundStrict(mirrored.toString('base64')), 'base64')
              : mirrored;
            fullImages[rightIdx] = { view: 'right', buffer: mirroredOut };
          } else {
            fullImages[rightIdx] = { view: 'right', buffer: outBuf };
          }
        }
      }
    }

    const compositeTiles = await Promise.all(
      fullImages.map(async (tile) => ({
        view: tile.view,
        buffer: await sharp(tile.buffer).resize(tileWidth, tileHeight, { fit: 'contain', background: tileBackground }).png().toBuffer(),
      }))
    );

    const composite = await composeComposite(compositeTiles, grid.columns, grid.rows, tileWidth, tileHeight, {
      background: tileBackground,
    });

    return safeJson(res, {
      compositeBase64: composite.buffer.toString('base64'),
      images: fullImages.map((tile) => ({ view: tile.view, imageBase64: tile.buffer.toString('base64') })),
      meta: {
        dimensions: composite.dimensions,
        grid: { ...grid, tileWidth, tileHeight },
        viewOrder: views,
      },
    });
  } catch (err: any) {
    console.error('Generate views from base error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/generate-uniform', async (req: Request, res: Response) => {
  const { prompt, resolution } = req.body as GenerateUniformRequestBody;

  if (!prompt || !prompt.trim()) {
    return safeJson(res, { error: 'Prompt is required.' }, 400);
  }

  if (!resolution || !allowedResolutions.has(resolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }

  try {
    const frontResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: buildUniformFrontPrompt(prompt.trim(), resolution),
    });

    const frontParts = (frontResponse as any)?.candidates?.[0]?.content?.parts;
    const frontInline = frontParts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!frontInline?.data) throw new Error('Gemini response did not include a front image.');
    const front = await normalizeGeminiOutputPngBase64(String(frontInline.data), resolution);

    const backResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildUniformBackPrompt(prompt.trim(), resolution) },
            { inlineData: pngBase64ToInlineData(front) },
          ],
        },
      ],
    });

    const backParts = (backResponse as any)?.candidates?.[0]?.content?.parts;
    const backInline = backParts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!backInline?.data) throw new Error('Gemini response did not include a back image.');
    const back = await normalizeGeminiOutputPngBase64(String(backInline.data), resolution);

    return safeJson(res, { front, back });
  } catch (err: any) {
    console.error('Generate uniform error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/uniform/generate-composite', async (req: Request, res: Response) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const resolution = Number(req.body?.resolution);
  const styleKey = normalizeIncomingStyleKey(req.body?.styleKey) ?? '3d';
  const referenceImageBase64 =
    typeof req.body?.referenceImageBase64 === 'string' ? req.body.referenceImageBase64.trim() : '';
  const viewsRaw = Array.isArray(req.body?.views) ? req.body.views : [];
  const views = viewsRaw
    .filter((v: any) => typeof v === 'string')
    .map((v: string) => v.trim() as UniformViewKey)
    .filter((v: UniformViewKey) => allowedUniformViews.has(v));

  if (!prompt) return safeJson(res, { error: 'Prompt is required.' }, 400);
  if (!resolution || !allowedResolutions.has(resolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }
  if (!allowedBaseStyles.has(styleKey)) {
    return safeJson(res, { error: 'Invalid styleKey. Allowed: line_art, watercolor, realistic, 3d_render.' }, 400);
  }
  if (!views.length) return safeJson(res, { error: 'Select at least one view.' }, 400);
  if (views.length > 4) return safeJson(res, { error: 'Maximum 4 views supported.' }, 400);

  try {
    const referenceInlineData = referenceImageBase64 ? pngBase64ToInlineData(referenceImageBase64) : null;
    const grid = computeGrid(views.length);
    const compositePrompt = buildUniformCompositePrompt({
      userPrompt: prompt,
      style: styleKey,
      views,
      columns: grid.columns,
      rows: grid.rows,
      resolution,
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                compositePrompt,
                referenceInlineData
                  ? 'Reference image provided: use it as a visual design reference. Preserve design identity while generating the requested grid views.'
                  : '',
              ]
                .filter(Boolean)
                .join(' '),
            },
            ...(referenceInlineData ? [{ inlineData: referenceInlineData }] : []),
          ],
        },
      ],
    });

    const parts = (response as any)?.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!imagePart?.data) {
      throw new Error('Gemini response did not include an image.');
    }

    const normalizedComposite = await normalizeGeminiOutputPngBase64(String(imagePart.data), resolution);
    const out = await cropCompositeToTiles({ compositePngBase64: normalizedComposite, resolution, views });
    return safeJson(res, out);
  } catch (err: any) {
    console.error('Uniform composite generation error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/uniform/convert-style', async (req: Request, res: Response) => {
  const compositeBase64 = typeof req.body?.compositeBase64 === 'string' ? req.body.compositeBase64.trim() : '';
  const resolution = Number(req.body?.resolution);
  const styleKey = normalizeIncomingStyleKey(req.body?.styleKey);
  const viewsRaw = Array.isArray(req.body?.views) ? req.body.views : [];
  const views = viewsRaw
    .filter((v: any) => typeof v === 'string')
    .map((v: string) => v.trim() as UniformViewKey)
    .filter((v: UniformViewKey) => allowedUniformViews.has(v));

  if (!compositeBase64) return safeJson(res, { error: 'compositeBase64 is required.' }, 400);
  if (!resolution || !allowedResolutions.has(resolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }
  if (!styleKey || !allowedBaseStyles.has(styleKey)) {
    return safeJson(res, { error: 'Invalid styleKey. Allowed: line_art, watercolor, realistic, 3d_render.' }, 400);
  }
  if (!views.length) return safeJson(res, { error: 'views is required.' }, 400);

  try {
    const inlineData = pngBase64ToInlineData(compositeBase64);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts: [{ text: buildCompositeStyleConversionPrompt(styleKey) }, { inlineData }] }],
    });

    const parts = (response as any)?.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!imagePart?.data) throw new Error('Gemini response did not include an image.');

    const normalizedComposite = await normalizeGeminiOutputPngBase64(String(imagePart.data), resolution);
    const out = await cropCompositeToTiles({ compositePngBase64: normalizedComposite, resolution, views });
    return safeJson(res, out);
  } catch (err: any) {
    console.error('Uniform convert style error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/uniform/convert-model', async (req: Request, res: Response) => {
  const compositeBase64 = typeof req.body?.compositeBase64 === 'string' ? req.body.compositeBase64.trim() : '';
  const resolution = Number(req.body?.resolution);
  const modelKey = typeof req.body?.modelKey === 'string' ? req.body.modelKey.trim().toLowerCase() : '';
  const viewsRaw = Array.isArray(req.body?.views) ? req.body.views : [];
  const views = viewsRaw
    .filter((v: any) => typeof v === 'string')
    .map((v: string) => v.trim() as UniformViewKey)
    .filter((v: UniformViewKey) => allowedUniformViews.has(v));

  if (!compositeBase64) return safeJson(res, { error: 'compositeBase64 is required.' }, 400);
  if (!resolution || !allowedResolutions.has(resolution)) {
    return safeJson(res, { error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` }, 400);
  }
  if (modelKey !== 'male' && modelKey !== 'female') {
    return safeJson(res, { error: 'Invalid modelKey. Allowed: male, female.' }, 400);
  }
  if (!views.length) return safeJson(res, { error: 'views is required.' }, 400);

  try {
    const inlineData = pngBase64ToInlineData(compositeBase64);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        { role: 'user', parts: [{ text: buildCompositeMannequinPrompt(modelKey as MannequinModelKey) }, { inlineData }] },
      ],
    });

    const parts = (response as any)?.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!imagePart?.data) throw new Error('Gemini response did not include an image.');

    const normalizedComposite = await normalizeGeminiOutputPngBase64(String(imagePart.data), resolution);
    const out = await cropCompositeToTiles({ compositePngBase64: normalizedComposite, resolution, views });
    return safeJson(res, out);
  } catch (err: any) {
    console.error('Uniform convert model error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/convert-style', async (req: Request, res: Response) => {
  const { images, imageFrontBase64, imageBackBase64, styleKey } = req.body as ConvertStyleRequestBody;
  const normalizedStyle = normalizeIncomingStyleKey(styleKey);

  if (!normalizedStyle || !allowedBaseStyles.has(normalizedStyle)) {
    return safeJson(res, { error: 'Invalid styleKey. Allowed: line_art, watercolor, realistic, 3d_render.' }, 400);
  }

  const fallbackImages: Array<{ view: ViewKey; imageBase64: string }> = [];
  if (typeof imageFrontBase64 === 'string' && imageFrontBase64.trim()) fallbackImages.push({ view: 'front', imageBase64: imageFrontBase64 });
  if (typeof imageBackBase64 === 'string' && imageBackBase64.trim()) fallbackImages.push({ view: 'back', imageBase64: imageBackBase64 });

  const incomingRaw = Array.isArray(images) && images.length ? images : fallbackImages;
  const incomingParsed = incomingRaw
    .filter((it: any) => it && typeof it.imageBase64 === 'string')
    .map((it: any) => ({
      rawView: it.view,
      view: normalizeIncomingViewKey(it.view),
      imageBase64: String(it.imageBase64 || '').trim(),
    }));

  if (!incomingParsed.length) return safeJson(res, { error: 'images is required.' }, 400);

  const invalidViews = incomingParsed.filter((it) => !it.view).map((it) => String(it.rawView));
  if (invalidViews.length) {
    return safeJson(res, { error: `Invalid view(s): ${invalidViews.join(', ')}` }, 400);
  }

  const emptyImages = incomingParsed.filter((it) => !it.imageBase64).map((it) => String(it.view));
  if (emptyImages.length) {
    return safeJson(res, { error: `Missing imageBase64 for view(s): ${emptyImages.join(', ')}` }, 400);
  }

  const incoming = incomingParsed.map((it) => ({ view: it.view as ViewKey, imageBase64: it.imageBase64 }));

  try {
    const isLineArt = normalizedStyle === 'lineart';

    const convertOne = async (pngBase64: string, promptText?: string) => {
      const inlineData = pngBase64ToInlineData(normalizePngBase64(pngBase64));
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [
          {
            role: 'user',
            parts: [{ text: promptText || buildStyleConversionPromptForUniform(normalizedStyle) }, { inlineData }],
          },
        ],
      });

      const parts = (response as any)?.candidates?.[0]?.content?.parts;
      const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
      if (!imagePart?.data) {
        throw new Error('Gemini response did not include an image.');
      }

      const normalized = await normalizeGeminiOutputPngBase64(String(imagePart.data), undefined, { background: WHITE_BG });
      return await ensureSolidWhiteBackgroundPngBase64(normalized);
    };

    const retryConversion = async (
      originalPngBase64: string,
      view: ViewKey,
      originalHasAlpha: boolean,
      target: { width: number; height: number }
    ): Promise<{ view: ViewKey; imageBase64: string }> => {
      if (isLineArt) {
        const prompt = [
          buildStyleConversionPrompt('lineart'),
          'STRICT: Keep the exact same framing, zoom, and size as the input image. Do not crop. Do not zoom.',
          'STRICT: Do not add any paper texture, dots, grain, halftone, or background noise.',
        ].join(' ');

        try {
          const outRaw = await convertOne(originalPngBase64, prompt);
          const out = await cleanupLineArtOutputToTarget(outRaw, target);
          await validateLineArtOutput(out);
          return { view, imageBase64: out };
        } catch (err) {
          try {
            const fallback = await fallbackLineArtEdgeDetectPngBase64(originalPngBase64);
            const out = await cleanupLineArtOutputToTarget(fallback, target);
            return { view, imageBase64: out };
          } catch {
            // Last resort: don't fail the whole request.
            return { view, imageBase64: originalPngBase64 };
          }
        }
      }

      const maxAttempts = 1;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const outRaw = await convertOne(originalPngBase64);
          if (!outRaw || typeof outRaw !== 'string' || !outRaw.trim()) throw new Error('Empty converted image.');

          // Non-lineart conversions should keep consistent dimensions with the original view.
          let out = await resizeToMatch(outRaw, target, WHITE_BG);
          out = await ensureSolidWhiteBackgroundPngBase64(out);
          return { view, imageBase64: out };
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) {
            console.warn(`Convert style retry ${attempt}/${maxAttempts - 1} for view "${view}"`);
          }
        }
      }

      console.warn(`Convert style failed for view "${view}", falling back to original.`, lastErr);
      return { view, imageBase64: originalPngBase64 };
    };

    const converted = await Promise.all(
      incoming.map(async (it) => {
        const original = normalizePngBase64(it.imageBase64);
        const originalHasAlpha = await hasMeaningfulTransparency(original).catch(() => false);
        const target = await getPngDimensions(original);
        return await retryConversion(original, it.view, originalHasAlpha, target);
      })
    );
    return safeJson(res, { converted });
  } catch (err: any) {
    console.error('Convert style error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/convert-model', async (req: Request, res: Response) => {
  const { images, imageFrontBase64, imageBackBase64, modelKey } = req.body as ConvertModelRequestBody;
  const styleRaw =
    typeof (req.body as any)?.style === 'string'
      ? String((req.body as any).style)
      : typeof (req.body as any)?.sourceStyle === 'string'
        ? String((req.body as any).sourceStyle)
        : '';
  const style = styleRaw.trim().toLowerCase();

  if (!modelKey || (modelKey !== 'male' && modelKey !== 'female')) {
    return safeJson(res, { error: 'Invalid modelKey. Allowed: male, female.' }, 400);
  }
  if (
    style &&
    style !== 'realistic' &&
    style !== '3d' &&
    style !== '3d_render' &&
    style !== 'lineart' &&
    style !== 'watercolor'
  ) {
    return safeJson(res, { error: 'Invalid style. Allowed: realistic, 3d, lineart, watercolor.' }, 400);
  }

  const fallbackImages: Array<{ view: ViewKey; imageBase64: string }> = [];
  if (typeof imageFrontBase64 === 'string' && imageFrontBase64.trim()) fallbackImages.push({ view: 'front', imageBase64: imageFrontBase64 });
  if (typeof imageBackBase64 === 'string' && imageBackBase64.trim()) fallbackImages.push({ view: 'back', imageBase64: imageBackBase64 });

  const incomingRaw = Array.isArray(images) && images.length ? images : fallbackImages;
  const incomingParsed = incomingRaw
    .filter((it: any) => it && typeof it.imageBase64 === 'string')
    .map((it: any) => ({
      rawView: it.view,
      view: normalizeIncomingViewKey(it.view),
      imageBase64: String(it.imageBase64 || '').trim(),
    }));

  if (!incomingParsed.length) return safeJson(res, { error: 'images is required.' }, 400);

  const invalidViews = incomingParsed.filter((it) => !it.view).map((it) => String(it.rawView));
  if (invalidViews.length) {
    return safeJson(res, { error: `Invalid view(s): ${invalidViews.join(', ')}` }, 400);
  }

  const emptyImages = incomingParsed.filter((it) => !it.imageBase64).map((it) => String(it.view));
  if (emptyImages.length) {
    return safeJson(res, { error: `Missing imageBase64 for view(s): ${emptyImages.join(', ')}` }, 400);
  }

  const incoming = incomingParsed.map((it) => ({ view: it.view as ViewKey, imageBase64: it.imageBase64 }));

  try {
    const incomingFrontBack = incoming.filter((it) => it?.view === 'front' || it?.view === 'back');
    if (!incomingFrontBack.length) return safeJson(res, { error: 'images must include front and/or back.' }, 400);

    const promptForView = (view: ViewKey) => {
      // Model previews should always be generated as realistic photography (never CGI/3D),
      // regardless of the selected generation/style in the UI.
      const constraints =
        (view === 'front' || view === 'back')
          ? buildTryOnModelViewConstraints(view)
          : '';
      if (constraints && isPromptEnhancerDebug() && !isProductionEnv()) {
        console.log('[ConvertModel]', { modelKey, view, referenceImageIncluded: true, constraints });
      }
      return view === 'back' ? modelBackPrompt(modelKey, constraints) : modelFrontPrompt(modelKey, constraints);
    };

    const convertOne = async (pngBase64: string, view: ViewKey, target: { width: number; height: number }) => {
      const input = normalizePngBase64(pngBase64);
      const inlineData = pngBase64ToInlineData(input);
      const basePrompt = promptForView(view);

      const maxAttempts = view === 'back' ? 3 : 2;
      let lastErr: any = null;
      let bestOut: string | null = null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const extra =
            attempt >= 2
              ? [
                'CRITICAL: Zoom OUT. The subject must occupy at most ~70% of image height.',
                'Add extra empty space above the head and below the feet. Feet must be fully visible.',
                'Do NOT crop any body part. Do NOT use a close-up.',
              ].join(' ')
              : '';
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [
              {
                role: 'user',
                parts: [{ inlineData }, { text: [basePrompt, extra].filter(Boolean).join(' ') }],
              },
            ],
          });

          const parts = (response as any)?.candidates?.[0]?.content?.parts;
          const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
          if (!imagePart?.data) throw new Error('Gemini response did not include an image.');

          let out = await normalizeGeminiOutputPngBase64(String(imagePart.data), undefined, { background: WHITE_BG });
          out = await ensureSolidWhiteBackgroundStrict(out);
          out = await resizeToMatch(out, target, WHITE_BG);

          const score = await scoreCroppingRiskOnWhiteBackground(out).catch(() => 9999);
          if (score < bestScore) {
            bestScore = score;
            bestOut = out;
          }
          // Good enough, stop early.
          if (score <= 28) return out;

          // Otherwise keep trying for a better-framed result.
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) console.warn(`Convert model retry ${attempt}/${maxAttempts - 1} for view "${view}"`);
        }
      }

      if (bestOut) return bestOut;
      throw lastErr instanceof Error ? lastErr : new Error('Model conversion failed.');
    };

    const converted = await Promise.all(
      incomingFrontBack.map(async (it) => {
        const input = normalizePngBase64(it.imageBase64);
        const target = await getPngDimensions(input);
        return { view: it.view, imageBase64: await convertOne(input, it.view, target) };
      })
    );
    return safeJson(res, { converted });
  } catch (err: any) {
    console.error('Convert model error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/export', jsonLarge, async (req: Request, res: Response) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    cleanupExportSessions();
    const formatRaw = typeof req.body?.format === 'string' ? req.body.format.trim().toLowerCase() : '';
    const format: ExportFormat = formatRaw === 'pdf' ? 'pdf' : formatRaw === 'composite' ? 'composite' : 'zip';
    const items: ExportItem[] = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!items.length) return safeJson(res, { error: 'items must be a non-empty array.' }, 400);
    const invalid = items.find((it: any) => !it?.name || typeof it.name !== 'string' || typeof it.imageBase64 !== 'string');
    if (invalid) return safeJson(res, { error: 'Each item must include { name, imageBase64 }.' }, 400);

    const exportId = randomUUID();
    exportSessions.set(exportId, { userId, format, items, createdAt: Date.now() });
    return safeJson(res, { exportId, url: `/api/export?exportId=${exportId}&uid=${encodeURIComponent(userId)}` });
  } catch (err: any) {
    console.error('Export init error:', err);
    return safeJson(res, { error: err?.message || 'Failed to prepare export.' }, 500);
  }
});

app.get('/api/export', async (req: Request, res: Response) => {
  const headerUserId = (req.headers['x-user-id'] as string | undefined)?.trim();
  const queryUserId = typeof req.query.uid === 'string' ? req.query.uid.trim() : '';
  const userId = headerUserId || queryUserId;
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    cleanupExportSessions();
    const exportId = typeof req.query.exportId === 'string' ? req.query.exportId.trim() : '';
    if (!exportId) return safeJson(res, { error: 'exportId is required.' }, 400);

    const sess = exportSessions.get(exportId);
    if (!sess || sess.userId !== userId) return safeJson(res, { error: 'Export not found.' }, 404);

    const items = sess.items;

    if (sess.format === 'zip') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=\"uniform-export-${exportId}.zip\"`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('Export zip error', err);
        if (!res.headersSent) res.status(500).end();
      });
      archive.pipe(res);

      for (const item of items) {
        const buf = Buffer.from(normalizePngBase64(item.imageBase64), 'base64');
        archive.append(buf, { name: item.name.endsWith('.png') ? item.name : `${item.name}.png` });
      }

      await archive.finalize();
      return;
    }

    if (sess.format === 'composite') {
      const png = await buildCompositeGridPng(items);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename=\"uniform-export-${exportId}.png\"`);
      res.end(png);
      return;
    }

    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const page = pdf.addPage([612, 792]); // letter
    const margin = 36;
    const gap = 12;
    const columns = 2;
    const cellW = (page.getWidth() - margin * 2 - gap) / columns;
    const cellH = cellW;
    let x = margin;
    let y = page.getHeight() - margin - cellH;

    page.drawText('Uniform Export', { x: margin, y: page.getHeight() - margin + 6, size: 14, font });

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const buf = Buffer.from(normalizePngBase64(item.imageBase64), 'base64');
      const png = await pdf.embedPng(buf);
      const scale = Math.min(cellW / png.width, cellH / png.height);
      const w = png.width * scale;
      const h = png.height * scale;
      const dx = x + (cellW - w) / 2;
      const dy = y + (cellH - h) / 2;

      page.drawImage(png, { x: dx, y: dy, width: w, height: h });
      page.drawText(item.name.replace(/\\.png$/i, ''), { x, y: y - 12, size: 9, font });

      if (i % columns === 0) {
        x = margin + cellW + gap;
      } else {
        x = margin;
        y -= cellH + 24 + gap;
      }
    }

    const bytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"uniform-export-${exportId}.pdf\"`);
    res.end(Buffer.from(bytes));
  } catch (err: any) {
    console.error('Export error:', err);
    if (!res.headersSent) safeJson(res, { error: err?.message || 'Export failed.' }, 500);
  }
});

app.get('/api/sam2/health', async (_req: Request, res: Response) => {
  return safeJson(res, { ok: true, mode: 'node-only' });
});

app.post('/api/sam2/color-layers-dynamic', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const rawMaxColors = Number(req.body?.max_colors ?? req.body?.maxColors ?? 8);
    const maxColors = Number.isFinite(rawMaxColors) ? Math.min(Math.max(Math.round(rawMaxColors), 2), 10) : 8;

    const rawMinAreaRatio = Number(req.body?.min_area_ratio ?? req.body?.minAreaRatio ?? 0.02);
    const minAreaRatio = Number.isFinite(rawMinAreaRatio) ? Math.min(Math.max(rawMinAreaRatio, 0), 0.5) : 0.02;

    const rawMergeThreshold = Number(req.body?.merge_threshold ?? req.body?.mergeThreshold ?? 12);
    const mergeThreshold = Number.isFinite(rawMergeThreshold) ? Math.min(Math.max(rawMergeThreshold, 0), 100) : 12;

    const rawSeed = Number(req.body?.seed ?? 42);
    const seed = Number.isFinite(rawSeed) ? Math.round(rawSeed) : 42;

    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' }, 400);
    }
    assertDataUrlSize(imageDataUrl);

    const fallback = await fallbackKmeansColorLayersDynamic({
      imageDataUrl,
      maxColors,
      minAreaRatio,
      mergeThreshold,
      seed,
    });

    return safeJson(res, {
      ok: true,
      width: fallback.width,
      height: fallback.height,
      layers: fallback.layers,
      sam2: { mode: 'node-kmeans-dynamic', available: true, modelLoaded: true, used: false },
    });
  } catch (err: any) {
    console.error('Color layers dynamic error:', err);
    return safeJson(res, { ok: false, error: err?.message || 'Layer detection failed.' }, 500);
  }
});

app.post('/api/sam2/color-layers', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const rawNumLayers = Number(req.body?.num_layers ?? req.body?.numLayers ?? 4);
    const numLayers = Number.isFinite(rawNumLayers) ? Math.min(Math.max(rawNumLayers, 2), 8) : 4;

    const rawMinAreaRatio = Number(req.body?.min_area_ratio ?? req.body?.minAreaRatio ?? 0.01);
    const minAreaRatio = Number.isFinite(rawMinAreaRatio) ? Math.min(Math.max(rawMinAreaRatio, 0), 0.5) : 0.01;

    const rawBlur = Number(req.body?.blur ?? 1);
    const blur = Number.isFinite(rawBlur) ? Math.min(Math.max(Math.round(rawBlur), 0), 9) : 1;

    const rawSeed = Number(req.body?.seed ?? 42);
    const seed = Number.isFinite(rawSeed) ? Math.round(rawSeed) : 42;

    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' }, 400);
    }
    assertDataUrlSize(imageDataUrl);

    const fallback = await fallbackKmeansColorLayers({ imageDataUrl, numLayers, minAreaRatio, blur, seed });
    return safeJson(res, {
      ok: true,
      width: fallback.width,
      height: fallback.height,
      layers: fallback.layers,
      sam2: { mode: 'node-kmeans', available: true, modelLoaded: true, used: false },
    });
  } catch (err: any) {
    console.error('Color layers error:', err);
    return safeJson(res, { ok: false, error: err?.message || 'Layer detection failed.' }, 500);
  }
});

app.post('/api/sam2/auto', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' }, 400);
    }
    assertDataUrlSize(imageDataUrl);

    const kmeans = await fallbackKmeansColorLayersDynamic({
      imageDataUrl,
      maxColors: 6,
      minAreaRatio: 0.02,
      mergeThreshold: 12,
      seed: 42,
    });
    const masks = Array.isArray(kmeans?.layers) ? kmeans.layers.map((l: any) => l?.maskPng).filter(Boolean) : [];
    return safeJson(res, { ok: true, masks, sam2: { mode: 'node-kmeans-dynamic', available: true, modelLoaded: true, used: false } });
  } catch (err: any) {
    console.error('Auto segmentation error:', err);
    return safeJson(res, { ok: false, error: err?.message || 'Automatic segmentation failed.' }, 500);
  }
});

app.post('/api/sam2/object-from-point', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);

    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' }, 400);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      return safeJson(res, { ok: false, error: 'x and y must be normalized coordinates (0..1).' }, 400);
    }
    assertDataUrlSize(imageDataUrl);

    const objectMaskDataUrl = await fallbackObjectMaskFromPoint({ imageDataUrl, x, y });
    return safeJson(res, { ok: true, objectMaskDataUrl, sam2: { mode: 'node-region-grow', used: false } });
  } catch (err: any) {
    console.error('Object-from-point error:', err);
    return safeJson(res, { ok: false, error: err?.message || 'Object selection failed.' }, 500);
  }
});

app.post('/api/sam2/split-colors-in-mask', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const objectMaskDataUrl = typeof req.body?.objectMaskDataUrl === 'string' ? req.body.objectMaskDataUrl.trim() : '';
    const rawMaxColors = Number(req.body?.max_colors ?? req.body?.maxColors ?? 6);
    const maxColors = Number.isFinite(rawMaxColors) ? Math.min(Math.max(Math.round(rawMaxColors), 2), 10) : 6;
    const rawMinAreaRatio = Number(req.body?.min_area_ratio ?? req.body?.minAreaRatio ?? 0.02);
    const minAreaRatio = Number.isFinite(rawMinAreaRatio) ? Math.min(Math.max(rawMinAreaRatio, 0), 0.5) : 0.02;
    const rawSeed = Number(req.body?.seed ?? 42);
    const seed = Number.isFinite(rawSeed) ? Math.round(rawSeed) : 42;

    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' }, 400);
    }
    if (!isPngDataUrl(objectMaskDataUrl)) {
      return safeJson(res, { ok: false, error: 'objectMaskDataUrl must be a PNG data URL.' }, 400);
    }
    assertDataUrlSize(imageDataUrl);
    assertDataUrlSize(objectMaskDataUrl);

    const layersOut = await fallbackSplitColorsInMask({
      imageDataUrl,
      objectMaskDataUrl,
      maxColors,
      minAreaRatio,
      seed,
    });
    return safeJson(res, {
      ok: true,
      layers: Array.isArray(layersOut?.layers) ? layersOut.layers : [],
      sam2: { mode: 'node-kmeans', available: true, modelLoaded: true, used: false },
    });
  } catch (err: any) {
    console.error('Split-colors-in-mask error:', err);
    return safeJson(res, { ok: false, error: err?.message || 'Color splitting failed.' }, 500);
  }
});

app.post('/api/realistic/render', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

    if (!isPngDataUrl(imageDataUrl)) {
      return safeJson(res, { ok: false, error: 'imageDataUrl must be a PNG data URL.' }, 400);
    }
    assertDataUrlSize(imageDataUrl);

    const inlineData = dataUrlToInlineData(imageDataUrl);
    const renderPrompt = [
      'Convert this design mockup into a photorealistic product photo.',
      'Keep layout and colors exactly the same.',
      'Preserve design placement.',
      'Improve lighting and material realism.',
      prompt ? `Additional notes: ${prompt}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            { text: renderPrompt },
            { inlineData },
          ],
        },
      ],
    });

    const parts = (response as any)?.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!imagePart?.data) {
      throw new Error('Gemini response did not include an image.');
    }

    return safeJson(res, { imageDataUrl: `data:image/png;base64,${imagePart.data}` });
  } catch (err: any) {
    console.error('Realistic render error:', err);
    return safeJson(res, { ok: false, error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/image/edit', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const style = typeof req.body?.style === 'string' ? req.body.style.trim() : '';
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    const resolutionRaw = Number(req.body?.resolution);
    const resolution = Number.isFinite(resolutionRaw) ? Math.round(resolutionRaw) : null;
    const viewAnglesRaw = Array.isArray(req.body?.viewAngles) ? req.body.viewAngles : Array.isArray(req.body?.views) ? req.body.views : [];
    const viewAngles = (Array.isArray(viewAnglesRaw) ? viewAnglesRaw : [])
      .filter((v: any) => typeof v === 'string')
      .map((v: string) => v.trim())
      .filter((v: string) => allowedViews.has(v as ViewKey))
      .slice(0, 6);

    if (!imageDataUrl.startsWith('data:image/')) {
      return safeJson(res, { error: 'imageDataUrl must be a data:image/* data URL.' }, 400);
    }
    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { error: 'imageDataUrl must be a PNG, JPG, or WEBP data URL.' }, 400);
    }
    assertEditDataUrlSize(imageDataUrl);

    if (!prompt) {
      return safeJson(res, { error: 'Prompt is required.' }, 400);
    }

    const inlineData = dataUrlToInlineImageData(imageDataUrl);
    const targetSize = allowedResolutions.has(resolution || -1) ? (resolution as number) : 1024;
    const styleNormalized = style.toLowerCase().replace(/[\s_-]+/g, '_');
    const cropMode: 'lineart' | 'photo' = styleNormalized === 'lineart' || styleNormalized === 'line_art' ? 'lineart' : 'photo';
    const viewAnglesLabel = viewAngles.length
      ? viewAngles.map((v) => viewLabels[v as ViewKey] || v).join(', ')
      : '';
    const singleViewHint = viewAngles.length === 1 ? `SINGLE VIEW ONLY: ${viewAnglesLabel}.` : '';
    const bgHint =
      cropMode === 'lineart'
        ? 'Background must be pure white.'
        : 'Background should be simple studio gray (no scenes, no patterns).';
    const editPrompt = [
      'You are editing an existing image.',
      'Apply ONLY the requested changes.',
      'Preserve composition, camera angle, fabric texture, folds, lighting, shadows, and all other details.',
      'Do not introduce new logos or text.',
      'If asked to remove a logo, remove it cleanly and fill naturally.',
      'Return ONE image only. DO NOT create a grid/collage/split-screen or multiple panels.',
      'One shirt only, centered, large in frame (fills ~70-85% of canvas).',
      singleViewHint,
      bgHint,
      'Output a PNG image.',
      style ? `Editing style: ${style}.` : '',
      model ? `Model preference: ${model}.` : '',
      resolution ? `Resolution preference: ${resolution}x${resolution}.` : '',
      viewAnglesLabel ? `View angles: ${viewAnglesLabel}.` : '',
      `Request: ${prompt}`,
    ]
      .filter(Boolean)
      .join(' ');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [{ text: editPrompt }, { inlineData }],
        },
      ],
    });

    const parts = (response as any)?.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
    if (!imagePart?.data) {
      throw new Error('Gemini response did not include an image.');
    }

    const cropped = await autoCropAndFitPng(Buffer.from(String(imagePart.data), 'base64'), targetSize, { mode: cropMode });
    return safeJson(res, { imageDataUrl: `data:image/png;base64,${cropped.toString('base64')}` });
  } catch (err: any) {
    console.error('Image edit error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/image/edit-views', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const style = typeof req.body?.style === 'string' ? req.body.style.trim() : '';
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    const resolutionRaw = req.body?.resolution;

    if (!imageDataUrl.startsWith('data:image/')) {
      return safeJson(res, { error: 'imageDataUrl must be a data:image/* data URL.' }, 400);
    }
    if (!isImageDataUrl(imageDataUrl)) {
      return safeJson(res, { error: 'imageDataUrl must be a PNG, JPG, or WEBP data URL.' }, 400);
    }
    assertEditDataUrlSize(imageDataUrl);

    if (!prompt) {
      return safeJson(res, { error: 'Prompt is required.' }, 400);
    }

    type EditViewKey = 'front' | 'back' | 'left' | 'right';
    type EditViewRequest = { view: EditViewKey; style: string; model?: string; resolution?: string };

    const allowedEditViews = new Set<EditViewKey>(['front', 'back', 'left', 'right']);

    const normalizeResolution = (value: unknown): string | null => {
      const fromNumber = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(fromNumber)) {
        const n = Math.round(fromNumber);
        return allowedResolutions.has(n) ? `${n}x${n}` : null;
      }
      if (typeof value !== 'string') return null;
      const match = value.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
      if (!match) return null;
      const w = Number(match[1]);
      const h = Number(match[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) return null;
      return allowedResolutions.has(w) ? `${w}x${h}` : null;
    };

    const normalizeModel = (value: unknown): 'male' | 'female' | 'kid' | null => {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === 'none' || normalized === 'null' || normalized === 'undefined') return null;
      if (normalized === 'male' || normalized === 'man' || normalized === 'men') return 'male';
      if (normalized === 'female' || normalized === 'woman' || normalized === 'women') return 'female';
      if (normalized === 'kid' || normalized === 'child' || normalized === 'kids') return 'kid';
      if (normalized.startsWith('male')) return 'male';
      if (normalized.startsWith('female')) return 'female';
      if (normalized.startsWith('kid')) return 'kid';
      return null;
    };

    const styleInstruction = (raw: string): string => {
      const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '_');
      if (normalized === 'realistic') return 'photorealistic studio product photo, natural lighting, sharp focus';
      if (normalized === '3d' || normalized === '3d_render' || normalized === 'render_3d')
        return 'high quality 3D render, PBR materials, studio lighting, clean background';
      if (normalized === 'watercolor')
        return 'watercolor illustration, soft bleeding edges, paper texture, gentle pigment blooms';
      if (normalized === 'line_art' || normalized === 'lineart')
        return 'clean black line art, white background, minimal shading, vector-like lines';
      return raw.trim() ? `Rendering style: ${raw.trim()}.` : '';
    };

    const is3dStyle = (raw: string) => {
      const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '_');
      return normalized === '3d' || normalized === '3d_render' || normalized === 'render_3d';
    };

    const isLineArtStyle = (raw: string) => {
      const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '_');
      return normalized === 'lineart' || normalized === 'line_art';
    };

    const averageBrightness01 = async (pngBase64: string) => {
      try {
        const buf = Buffer.from(pngBase64, 'base64');
        const stats = await sharp(buf).removeAlpha().stats();
        const r = stats.channels[0]?.mean ?? 0;
        const g = stats.channels[1]?.mean ?? 0;
        const b = stats.channels[2]?.mean ?? 0;
        return (r + g + b) / (3 * 255);
      } catch {
        return null;
      }
    };

    const viewCue: Record<EditViewKey, string> = {
      front: 'Show a clear front view facing the camera.',
      back: 'Show a clear back view; back side facing the camera.',
      left: 'Show a clear left side profile; left side facing the camera.',
      right: 'Show a clear right side profile; right side facing the camera.',
    };

    const parseRequests = (): EditViewRequest[] => {
      if (Array.isArray(req.body?.requests)) {
        return req.body.requests
          .filter((item: any) => item && typeof item === 'object')
          .map((item: any) => ({
            view: item.view,
            style: item.style,
            model: item.model,
            resolution: item.resolution,
          }));
      }

      const viewsRaw = Array.isArray(req.body?.views) ? req.body.views : [];
      const views = viewsRaw
        .filter((v: any) => typeof v === 'string')
        .map((v: string) => v.trim().toLowerCase())
        .filter((v: string) => allowedEditViews.has(v as EditViewKey));

      if (!views.length) return [];

      const globalResolution = normalizeResolution(resolutionRaw);
      return views.map((view) => ({
        view: view as EditViewKey,
        style,
        model,
        resolution: globalResolution ?? undefined,
      }));
    };

    const requestsRaw = parseRequests();
    if (!requestsRaw.length) {
      return safeJson(res, { error: 'requests is required (at least 1).' }, 400);
    }
    if (requestsRaw.length > 4) {
      return safeJson(res, { error: 'Maximum 4 requests are allowed.' }, 400);
    }

    const normalizedRequests: EditViewRequest[] = [];
    const seenViews = new Set<EditViewKey>();
    for (const raw of requestsRaw) {
      const view = typeof raw?.view === 'string' ? raw.view.trim().toLowerCase() : '';
      const styleValue = typeof raw?.style === 'string' ? raw.style.trim() : '';
      const modelValue = typeof raw?.model === 'string' ? raw.model.trim() : '';
      const resolutionValue = typeof raw?.resolution === 'string' ? raw.resolution.trim() : '';

      if (!allowedEditViews.has(view as EditViewKey)) {
        return safeJson(res, { error: 'Invalid view value in requests.' }, 400);
      }
      const viewKey = view as EditViewKey;
      if (seenViews.has(viewKey)) {
        return safeJson(res, { error: 'Duplicate view entries are not allowed.' }, 400);
      }
      seenViews.add(viewKey);

      if (!styleValue) {
        return safeJson(res, { error: 'Each request must include a style.' }, 400);
      }

      const normalizedResolution =
        normalizeResolution(resolutionValue) ?? normalizeResolution(resolutionRaw) ?? undefined;
      normalizedRequests.push({
        view: viewKey,
        style: styleValue,
        model: modelValue || model || undefined,
        resolution: normalizedResolution,
      });
    }

    const inlineData = dataUrlToInlineImageData(imageDataUrl);

    const baseInstruction = [
      'You are editing an existing image.',
      'Preserve the garment/product identity and all details except the requested changes.',
      'Preserve composition, fabric texture, folds, lighting, and shadows unless the chosen style requires otherwise.',
      'Apply ONLY the user requested changes.',
      'Do NOT introduce new logos or text.',
      'Output a single PNG image.',
    ].join(' ');

    const perView = await Promise.allSettled(
      normalizedRequests.map(async (reqItem) => {
        const targetSize = parseSquareResolutionToTargetSize(reqItem.resolution, 1024);
        const modelPref = normalizeModel(reqItem.model);
        const modelInstruction =
          modelPref === 'male'
            ? 'Present the garment on a male model; keep garment design identical.'
            : modelPref === 'female'
              ? 'Present the garment on a female model; keep garment design identical.'
              : modelPref === 'kid'
                ? 'Present the garment on a child model; keep garment design identical.'
                : 'Do not change subject type; keep original subject.';

        const needsColorLock = is3dStyle(reqItem.style) && (reqItem.view === 'left' || reqItem.view === 'right');
        const colorLockInstruction = needsColorLock
          ? [
            'Color lock (strict): preserve the exact colors and materials from the input image.',
            'Do not shift hues, do not change garment colors, and do not wash out contrast.',
            'Keep black/white areas and fabric material appearance identical to the original unless explicitly requested.',
          ].join(' ')
          : '';
        const outputConstraints = [
          'Output constraints:',
          `- SINGLE VIEW ONLY: ${reqItem.view}`,
          '- No collage, no grid, no split frames, no multiple panels',
          '- One shirt only, centered, large in frame (fills ~70-85% of canvas)',
          '- DO NOT include multiple shirts/variants',
          isLineArtStyle(reqItem.style)
            ? '- Background must be pure white'
            : '- Background should be simple studio gray',
        ].join(' ');

        const generateImageBase64 = async (instruction: string) => {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [
              {
                role: 'user',
                parts: [{ text: instruction }, { inlineData }],
              },
            ],
          });

          const parts = (response as any)?.candidates?.[0]?.content?.parts;
          const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;
          if (!imagePart?.data) {
            throw new Error('Gemini response did not include an image.');
          }
          return String(imagePart.data);
        };

        const instruction = [
          baseInstruction,
          'Return ONE image containing ONLY the requested single view.',
          'DO NOT create a grid/collage/split-screen.',
          outputConstraints,
          `This MUST be the ${viewLabels[reqItem.view]} angle.`,
          viewCue[reqItem.view],
          colorLockInstruction,
          styleInstruction(reqItem.style),
          modelInstruction,
          reqItem.resolution ? `Output a square image at ${reqItem.resolution}.` : '',
          `User edit request: ${prompt}`,
        ]
          .filter(Boolean)
          .join(' ');

        let base64 = await generateImageBase64(instruction);

        if (needsColorLock) {
          const brightness = await averageBrightness01(base64);
          if (brightness != null && brightness > 0.85) {
            const retryInstruction = [
              instruction,
              'Retry (stronger color lock): DO NOT output a white shirt; the torso must be black and sleeves white.',
            ].join(' ');
            base64 = await generateImageBase64(retryInstruction);
          }
        }

        const cropMode: 'lineart' | 'photo' = isLineArtStyle(reqItem.style) ? 'lineart' : 'photo';
        const cropped = await autoCropAndFitPng(Buffer.from(base64, 'base64'), targetSize, { mode: cropMode });
        return { view: reqItem.view, style: reqItem.style, imageDataUrl: `data:image/png;base64,${cropped.toString('base64')}` };
      })
    );

    const results = perView.map((item, idx) => {
      const reqItem = normalizedRequests[idx];
      if (item.status === 'fulfilled') return item.value;
      return { view: reqItem.view, style: reqItem.style, error: mapGeminiError(item.reason) };
    });

    return safeJson(res, { results });
  } catch (err: any) {
    console.error('Image edit-views error:', err);
    return safeJson(res, { error: mapGeminiError(err) }, 500);
  }
});

app.post('/api/image/generate', async (req: Request, res: Response) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();

  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const widthRaw = Number(req.body?.width);
    const heightRaw = Number(req.body?.height);
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim() : 'Custom';
    const designType = typeof req.body?.designType === 'string' ? req.body.designType.trim() : 'post';
    const presetId = typeof req.body?.presetId === 'string' ? req.body.presetId.trim() : undefined;
    const variationSeed = typeof req.body?.variationSeed === 'string' ? req.body.variationSeed.trim() : '';

    if (!prompt) return safeJson(res, { error: 'Prompt is required.' }, 400);
    const width = Math.min(4096, Math.max(64, Math.round(Number.isFinite(widthRaw) ? widthRaw : 1080)));
    const height = Math.min(4096, Math.max(64, Math.round(Number.isFinite(heightRaw) ? heightRaw : 1080)));

    const batchId = randomUUID();
    const createdAt = new Date().toISOString();

    const hashToHue = (input: string) => {
      let h = 0;
      for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
      return h % 360;
    };

    const buildSvg = (idx: number) => {
      const hueA = hashToHue(`${variationSeed}|${batchId}|${idx}|a`);
      const hueB = (hueA + 38 + idx * 13) % 360;
      const safePrompt = prompt.replace(/[<>]/g, '').slice(0, 120);
      const meta = `${platform} • ${designType} • ${width}×${height}`;
      return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hueA} 85% 60%)"/>
      <stop offset="100%" stop-color="hsl(${hueB} 85% 60%)"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000" flood-opacity="0.25"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="${Math.round(width * 0.07)}" y="${Math.round(height * 0.08)}" width="${Math.round(
        width * 0.86
      )}" height="${Math.round(height * 0.84)}" rx="28" fill="rgba(255,255,255,0.90)" filter="url(#shadow)"/>
  <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.2)}" fill="#0f172a" font-size="${Math.max(
        18,
        Math.round(Math.min(width, height) * 0.045)
      )}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-weight="700">
    AI Image Generator (stub)
  </text>
  <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.27)}" fill="#334155" font-size="${Math.max(
        12,
        Math.round(Math.min(width, height) * 0.028)
      )}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial">
    ${meta}
  </text>
  <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.36)}" fill="#475569" font-size="${Math.max(
        12,
        Math.round(Math.min(width, height) * 0.026)
      )}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial">
    Prompt:
  </text>
  <foreignObject x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.39)}" width="${Math.round(
        width * 0.8
      )}" height="${Math.round(height * 0.5)}">
    <div xmlns="http://www.w3.org/1999/xhtml"
         style="color:#0f172a;font-size:${Math.max(12, Math.round(Math.min(width, height) * 0.03))}px;font-family:ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;line-height:1.25;word-break:break-word;">
      ${safePrompt}
    </div>
  </foreignObject>
  <text x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.92)}" fill="#64748b" font-size="${Math.max(
        10,
        Math.round(Math.min(width, height) * 0.022)
      )}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial">
    Variation ${idx + 1} • ${new Date().toLocaleString()}
  </text>
</svg>`;
    };

    const count = 4;
    const images = await Promise.all(
      Array.from({ length: count }, async (_unused, idx) => {
        const svg = buildSvg(idx);
        const png = await sharp(Buffer.from(svg)).png().toBuffer();
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        return {
          id: randomUUID(),
          url: dataUrl,
          width,
          height,
          prompt,
          createdAt,
        };
      })
    );

    let designId: string | undefined = undefined;
    if (userId) {
      try {
        await connectMongo();
        const fileIds = await Promise.all(
          images.map((img, idx) =>
            uploadDataUrlToGridFS(img.url, `social-${platform}-${designType}-${width}x${height}-${idx + 1}-${Date.now()}.png`)
          )
        );
        const views = images.map((_img, idx) => `variation-${idx + 1}`);
        const doc = await Design.create({
          name: `Social ${platform} ${designType}`.slice(0, 60),
          title: `Social ${platform} ${designType}`.slice(0, 60),
          prompt,
          userId,
          style: 'realistic',
          resolution: Math.max(width, height),
          views,
          composite: { mime: 'image/png', fileId: fileIds[0]?.toString?.() ?? String(fileIds[0]) },
          images: images.map((_img, idx) => ({
            view: views[idx],
            mime: 'image/png',
            fileId: fileIds[idx]?.toString?.() ?? String(fileIds[idx]),
          })),
        });
        designId = doc?._id?.toString?.() ?? undefined;
      } catch (err) {
        console.warn('Skipping persistence for /api/image/generate (Mongo unavailable)', err);
      }
    }

    return safeJson(res, { batchId, images, designId });
  } catch (err: any) {
    console.error('Image generate error:', err);
    return safeJson(res, { error: err instanceof Error ? err.message : 'Generation failed.' }, 500);
  }
});

app.get('/api/health', (_req, res) => {
  return safeJson(res, { status: 'ok' });
});

app.post('/api/designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const validation = validateDesignPayload({ ...req.body, userId });
    if (!validation.ok) {
      return safeJson(res, { error: validation.error }, 400);
    }
    const resolveInternalUrl = (url: string) => {
      if (!url.startsWith('/api/')) return url;
      const protoHeader = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const proto = protoHeader || req.protocol || 'http';
      const host = req.get('host') || 'localhost';
      return `${proto}://${host}${url}`;
    };

    const fetchPngDataUrl = async (url: string) => {
      const resolved = resolveInternalUrl(url);
      const response = await fetchWithTimeout(
        resolved,
        {
          headers: {
            'x-user-id': userId,
          },
        },
        15000
      );
      if (!response.ok) {
        throw new Error('Failed to fetch image for saving.');
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('image/png')) {
        throw new Error('Only PNG images can be saved.');
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error('Image payload too large (max 12MB).');
      }
      return `data:image/png;base64,${buffer.toString('base64')}`;
    };

    const resolvePngInputToDataUrl = async (input: { dataUrl?: string; url?: string }) => {
      if (typeof input.dataUrl === 'string' && isPngDataUrl(input.dataUrl)) {
        assertDataUrlSize(input.dataUrl);
        return input.dataUrl;
      }
      if (typeof input.url === 'string' && input.url) {
        return await fetchPngDataUrl(input.url);
      }
      throw new Error('Image must be a PNG data URL.');
    };

    const imageDataUrls = await Promise.all(validation.data.images.map((img: any) => resolvePngInputToDataUrl(img)));

    const imageFileIds = await Promise.all(
      imageDataUrls.map((dataUrl, idx) =>
        uploadDataUrlToGridFS(dataUrl, `${validation.data.images[idx]?.view || idx}-${Date.now()}.png`)
      )
    );

    let compositeField: any | undefined = undefined;
    if (validation.data.composite) {
      const compositeDataUrl = await resolvePngInputToDataUrl(validation.data.composite);
      const compositeFileId = await uploadDataUrlToGridFS(compositeDataUrl, `composite-${Date.now()}.png`);
      compositeField = { mime: 'image/png', fileId: compositeFileId.toString() };
    }

    const { composite: _composite, ...dataWithoutComposite } = validation.data as any;
    const doc = await Design.create({
      ...dataWithoutComposite,
      ...(compositeField ? { composite: compositeField } : {}),
      images: validation.data.images.map((img: any, idx: number) => ({
        view: img.view,
        mime: img.mime,
        fileId: imageFileIds[idx].toString(),
      })),
    });
    return safeJson(res, { id: doc._id.toString() });
  } catch (err) {
    console.error('Failed to save design', err);
    return safeJson(res, { error: err instanceof Error ? err.message : 'Failed to save design.' }, 500);
  }
});

app.get('/api/designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);
  try {
    const limitRaw = Number(req.query.limit) || 24;
    const limit = Math.min(Math.max(limitRaw, 1), 50);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const filter: any = { userId };
    if (cursor && Types.ObjectId.isValid(cursor)) {
      filter._id = { $lt: new Types.ObjectId(cursor) };
    }

    const docs = await Design.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const items = docs.slice(0, limit).map((doc) => ({
      id: doc._id.toString(),
      name: doc.name || doc.title || 'Untitled Design',
      title: doc.title || doc.name || 'Untitled Design',
      createdAt: doc.createdAt,
      style: doc.style,
      resolution: doc.resolution,
      views: doc.views,
      thumbnail:
        buildFileUrl(doc.composite?.fileId) ||
        doc.composite?.dataUrl ||
        buildFileUrl(doc.images?.[0]?.fileId) ||
        doc.images?.[0]?.dataUrl ||
        '',
    }));

    const nextCursor = docs.length > limit ? docs[limit]._id.toString() : null;

    return safeJson(res, { items, nextCursor });
  } catch (err) {
    console.error('Failed to list designs', err);
    return safeJson(res, { error: 'Failed to load designs.' }, 500);
  }
});

app.get('/api/designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid design id.' }, 400);
    }

    const doc = await Design.findOne({ _id: id, userId });
    if (!doc) {
      return safeJson(res, { error: 'Design not found.' }, 404);
    }

    return safeJson(res, {
      id: doc._id.toString(),
      name: doc.name || doc.title,
      title: doc.title || doc.name,
      prompt: doc.prompt,
      style: doc.style,
      resolution: doc.resolution,
      views: doc.views,
      composite:
        doc.composite?.fileId || doc.composite?.dataUrl
          ? {
            mime: doc.composite?.mime,
            url: buildFileUrl(doc.composite?.fileId),
            dataUrl: doc.composite?.dataUrl,
          }
          : null,
      images: doc.images.map((img: any) => ({
        view: img.view,
        mime: img.mime,
        url: buildFileUrl(img.fileId),
        dataUrl: img.dataUrl,
      })),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    console.error('Failed to fetch design', err);
    return safeJson(res, { error: 'Failed to load design.' }, 500);
  }
});

app.delete('/api/designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid design id.' }, 400);
    }
    const doc = await Design.findOneAndDelete({ _id: id, userId });
    if (doc) {
      const fileIds = [
        doc.composite?.fileId,
        ...doc.images.map((img: any) => img.fileId).filter(Boolean),
      ].filter(Boolean) as string[];
      await Promise.all(fileIds.map((fid) => deleteGridFSFile(fid)));
    }
    return safeJson(res, { ok: true });
  } catch (err) {
    console.error('Failed to delete design', err);
    return safeJson(res, { error: 'Failed to delete design.' }, 500);
  }
});

app.get('/api/designs/:id/download.zip', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid design id.' }, 400);
    }

    const doc = await Design.findOne({ _id: id, userId });
    if (!doc) {
      return safeJson(res, { error: 'Design not found.' }, 404);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="design-${id}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('Zip error', err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    archive.pipe(res);

    // Composite (optional; not saved by the multi-view generator anymore)
    if (doc.composite?.fileId) {
      const stream = await getReadStream(doc.composite.fileId);
      archive.append(stream, { name: 'composite.png' });
    } else if (doc.composite?.dataUrl) {
      const { buffer } = dataUrlToBuffer(doc.composite.dataUrl);
      archive.append(buffer, { name: 'composite.png' });
    }

    // Cropped views
    for (const img of doc.images) {
      const filename = `${img.view || 'view'}.png`;
      if (img.fileId) {
        const stream = await getReadStream(img.fileId);
        archive.append(stream, { name: filename });
      } else if (img.dataUrl) {
        const { buffer } = dataUrlToBuffer(img.dataUrl);
        archive.append(buffer, { name: filename });
      }
    }

    archive.finalize();
  } catch (err) {
    console.error('Failed to download zip', err);
    if (!res.headersSent) {
      safeJson(res, { error: 'Failed to download zip.' }, 500);
    }
  }
});

app.post('/api/video/render', jsonLarge, async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const project = req.body?.project;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const jobId = await createVideoJob(project, userId, baseUrl);
    return safeJson(res, { jobId });
  } catch (err: any) {
    console.error('Video render failed', err);
    return safeJson(res, { error: err?.message || 'Failed to render video.' }, 400);
  }
});

app.get('/api/video/status/:id', (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  const job = getVideoJob(req.params.id);
  if (!job) return safeJson(res, { error: 'Job not found.' }, 404);
  if (job.userId && job.userId !== userId) return safeJson(res, { error: 'Job not found.' }, 404);
  return safeJson(res, { status: job.status, error: job.error, progress: job.progress });
});

app.get('/api/video/download/:id', (req, res) => {
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  const { id } = req.params;
  const job = getVideoJob(id);
  if (!job) return safeJson(res, { error: 'Job not found.' }, 404);
  if (job.userId && job.userId !== userId) return safeJson(res, { error: 'Job not found.' }, 404);
  if (job.status !== 'done' || !hasJobOutput(id)) {
    return safeJson(res, { error: 'Video not ready.' }, 409);
  }

  const outputPath = getJobOutputPath(id)!;
  const range = req.headers.range;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="video-${id}.mp4"`);
  res.setHeader('Cache-Control', 'private, max-age=0');
  res.setHeader('Accept-Ranges', 'bytes');

  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(outputPath);
  } catch {
    stats = null;
  }

  if (!range || !stats?.isFile()) {
    if (stats?.isFile()) {
      res.setHeader('Content-Length', stats.size.toString());
    }
    res.sendFile(outputPath);
    return;
  }

  const size = stats.size;
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;

  if (Number.isNaN(start)) {
    if (!Number.isFinite(end) || end <= 0) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    start = Math.max(size - end, 0);
    end = size - 1;
  } else {
    if (Number.isNaN(end) || end >= size) {
      end = size - 1;
    }
  }

  if (start < 0 || start > end || start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(outputPath, { start, end });
  stream.on('error', (err) => {
    console.error('Video stream error', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  stream.pipe(res);
  return;
});

app.post('/api/video-designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const title = String(req.body?.title || '').trim();
    const jobId = String(req.body?.jobId || '').trim();
    const project = req.body?.project;

    if (!title) return safeJson(res, { error: 'Missing title.' }, 400);
    if (title.length > 80) return safeJson(res, { error: 'Title is too long.' }, 400);
    if (!jobId) return safeJson(res, { error: 'Missing jobId.' }, 400);

    const job = getVideoJob(jobId);
    if (!job || (job.userId && job.userId !== userId)) {
      return safeJson(res, { error: 'Job not found.' }, 404);
    }
    if (job.status !== 'done' || !hasJobOutput(jobId)) {
      return safeJson(res, { error: 'Video not ready.' }, 409);
    }

    const outputPath = getJobOutputPath(jobId)!;
    const videoFileId = await uploadFileToGridFS(outputPath, `video-${Date.now()}.mp4`, 'video/mp4');

    const doc = await VideoDesign.create({
      title,
      userId,
      video: { mime: 'video/mp4', fileId: videoFileId.toString() },
      project,
    });

    return safeJson(res, {
      id: doc._id.toString(),
      title: doc.title,
      downloadUrl: `/api/video-designs/${doc._id.toString()}/download.mp4`,
    });
  } catch (err: any) {
    console.error('Failed to save video design', err);
    return safeJson(res, { error: err?.message || 'Failed to save video.' }, 500);
  }
});

app.get('/api/video-designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 24)));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';

    const filter: any = { userId };
    if (cursor && Types.ObjectId.isValid(cursor)) {
      filter._id = { $lt: new Types.ObjectId(cursor) };
    }

    const docs = await VideoDesign.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const items = docs.slice(0, limit).map((doc) => ({
      id: doc._id.toString(),
      title: doc.title,
      createdAt: doc.createdAt,
    }));

    const nextCursor = docs.length > limit ? docs[limit]._id.toString() : null;
    return safeJson(res, { items, nextCursor });
  } catch (err) {
    console.error('Failed to list video designs', err);
    return safeJson(res, { error: 'Failed to load videos.' }, 500);
  }
});

app.get('/api/video-designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid video id.' }, 400);
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return safeJson(res, { error: 'Video not found.' }, 404);

    return safeJson(res, {
      id: doc._id.toString(),
      title: doc.title,
      createdAt: doc.createdAt,
      downloadUrl: `/api/video-designs/${doc._id.toString()}/download.mp4`,
    });
  } catch (err) {
    console.error('Failed to fetch video design', err);
    return safeJson(res, { error: 'Failed to load video.' }, 500);
  }
});

app.delete('/api/video-designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid video id.' }, 400);
    }

    const doc = await VideoDesign.findOneAndDelete({ _id: id, userId });
    if (doc?.video?.fileId) {
      await deleteGridFSFile(doc.video.fileId);
    }
    return safeJson(res, { ok: true });
  } catch (err) {
    console.error('Failed to delete video design', err);
    return safeJson(res, { error: 'Failed to delete video.' }, 500);
  }
});

app.get('/api/video-designs/:id/download.mp4', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid video id.' }, 400);
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return safeJson(res, { error: 'Video not found.' }, 404);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video-${id}.mp4"`);
    res.setHeader('Cache-Control', 'private, max-age=0');

    const stream = await getReadStream(doc.video.fileId);
    stream.on('error', (err) => {
      console.error('Video stream error', err);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Failed to download video', err);
    if (!res.headersSent) safeJson(res, { error: 'Failed to download video.' }, 500);
  }
});

app.get('/api/video-designs/:id/stream.mp4', async (req, res) => {
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return safeJson(res, { error: 'Invalid video id.' }, 400);
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return safeJson(res, { error: 'Video not found.' }, 404);

    const fileInfo = await getFileInfo(doc.video.fileId);
    if (!fileInfo) return safeJson(res, { error: 'Video file not found.' }, 404);

    const size = Number(fileInfo.length || 0);
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="video-${id}.mp4"`);
    res.setHeader('Cache-Control', 'private, max-age=0');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range || !size) {
      if (size) res.setHeader('Content-Length', String(size));
      const stream = await getReadStream(doc.video.fileId);
      stream.on('error', (err) => {
        console.error('Video stream error', err);
        if (!res.headersSent) res.status(500);
        res.end();
      });
      stream.pipe(res);
      return;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }

    let start = match[1] ? Number(match[1]) : NaN;
    let end = match[2] ? Number(match[2]) : NaN;

    if (Number.isNaN(start)) {
      if (!Number.isFinite(end) || end <= 0) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
        return;
      }
      start = Math.max(size - end, 0);
      end = size - 1;
    } else {
      if (Number.isNaN(end) || end >= size) {
        end = size - 1;
      }
    }

    if (start < 0 || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));

    const stream = await getReadStreamRange(doc.video.fileId, start, end);
    stream.on('error', (err) => {
      console.error('Video stream error', err);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Failed to stream video', err);
    if (!res.headersSent) safeJson(res, { error: 'Failed to stream video.' }, 500);
  }
});

const videoUploadTmpDir = path.join(os.tmpdir(), 'ai-designer-video-uploads');
fs.mkdirSync(videoUploadTmpDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, videoUploadTmpDir),
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'upload').replace(/[^\w.\-]+/g, '_').slice(0, 80);
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`);
    },
  }),
  limits: { fileSize: MAX_VIDEO_UPLOAD_BYTES, files: MAX_VIDEO_SLIDES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, and WEBP images are supported.'));
    }
    cb(null, true);
  },
});

app.post('/api/video/upload', upload.array('files', MAX_VIDEO_SLIDES), async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  try {
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) {
      return safeJson(res, { error: 'No files uploaded.' }, 400);
    }
    const assets = await Promise.all(
      files.map(async (file) => {
        if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
          throw new Error('Image too large.');
        }
        const saved = await saveUploadedAsset(file, userId);
        return { assetId: saved.assetId, url: `/api/video/assets/${saved.assetId}` };
      })
    );
    return safeJson(res, { assets });
  } catch (err: any) {
    const files = (req.files as Express.Multer.File[]) || [];
    await Promise.all(
      files.map(async (file) => {
        const filePath = (file as any).path;
        if (typeof filePath !== 'string' || !filePath) return;
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // Best-effort cleanup.
        }
      })
    );
    return safeJson(res, { error: err?.message || 'Upload failed.' }, 400);
  }
});

app.get('/api/video/assets/:id', (req, res) => {
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
  if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

  const info = getAssetInfo(req.params.id, userId);
  if (!info) return safeJson(res, { error: 'Asset not found.' }, 404);
  res.setHeader('Content-Type', info.mime);
  res.setHeader('Content-Length', info.size.toString());
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(info.path);
});

app.get('/api/video/files/:fileId', async (req: Request, res: Response) => {
  try {
    const userId =
      ((req.headers['x-user-id'] as string | undefined)?.trim() ||
        (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
      '';
    if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

    const { fileId } = req.params;
    if (!Types.ObjectId.isValid(fileId)) return safeJson(res, { error: 'Invalid file id.' }, 400);
    const fileObjectId = new Types.ObjectId(fileId);

    const owner = await Design.findOne({
      userId,
      $or: [
        { 'composite.fileId': fileId },
        { 'composite.fileId': fileObjectId },
        { 'images.fileId': fileId },
        { 'images.fileId': fileObjectId },
      ],
    }).select({ _id: 1 });
    if (!owner) {
      return safeJson(res, { error: 'File not found.' }, 404);
    }

    const fileInfo = await getFileInfo(fileId);
    if (!fileInfo) return safeJson(res, { error: 'File not found.' }, 404);

    const etag = `"${fileInfo._id.toString()}-${fileInfo.length}-${fileInfo.uploadDate?.getTime() || ''}"`;
    const lastModified = fileInfo.uploadDate ? new Date(fileInfo.uploadDate).toUTCString() : undefined;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    if (lastModified && req.headers['if-modified-since'] === lastModified) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', fileInfo.contentType || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    if (lastModified) res.setHeader('Last-Modified', lastModified);
    if (fileInfo.length) res.setHeader('Content-Length', fileInfo.length.toString());

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    const stream = await getReadStream(fileId);
    stream.on('error', (err) => {
      console.error('Stream error', err);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Failed to read file', err);
    if (!res.headersSent) safeJson(res, { error: 'File not found.' }, 404);
  }
});

app.use((err: any, _req: Request, res: Response, next: () => void) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return safeJson(
        res,
        { error: `File too large (max ${(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB).` },
        413
      );
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return safeJson(res, { error: `Too many files (max ${MAX_VIDEO_SLIDES}).` }, 413);
    }
    return safeJson(res, { error: err.message }, 400);
  }
  if (err?.message?.includes('Only PNG')) {
    return safeJson(res, { error: err.message }, 415);
  }
  next();
});

app.get('/api/ping-db', async (_req, res) => {
  try {
    const db = await getDb();
    const info = await db.admin().serverInfo();
    return safeJson(res, { ok: true, version: info.version });
  } catch (err) {
    console.error('Mongo ping failed', err);
    return safeJson(res, { ok: false, error: 'Mongo unavailable' }, 500);
  }
});

app.get('/api/health/gemini-key', (_req, res) => {
  return safeJson(res, {
    cwd: process.cwd(),
    loadedRootEnv,
    loadedServerEnv,
    geminiKeyLength: GEMINI_KEY.length,
    geminiKeyMasked:
      GEMINI_KEY.length >= 8 ? `${GEMINI_KEY.slice(0, 4)}...${GEMINI_KEY.slice(-4)}` : '(too short)',
  });
});

const fileHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) return safeJson(res, { error: 'Missing user id' }, 401);

    const { fileId } = req.params;
    if (!Types.ObjectId.isValid(fileId)) return safeJson(res, { error: 'Invalid file id.' }, 400);

    const owner = await Design.findOne({
      userId,
      $or: [{ 'composite.fileId': fileId }, { 'images.fileId': fileId }],
    }).select({ _id: 1 });
    if (!owner) {
      return safeJson(res, { error: 'File not found.' }, 404);
    }

    const fileInfo = await getFileInfo(fileId);
    if (!fileInfo) return safeJson(res, { error: 'File not found.' }, 404);

    const etag = `"${fileInfo._id.toString()}-${fileInfo.length}-${fileInfo.uploadDate?.getTime() || ''}"`;
    const lastModified = fileInfo.uploadDate ? new Date(fileInfo.uploadDate).toUTCString() : undefined;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    if (lastModified && req.headers['if-modified-since'] === lastModified) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', fileInfo.contentType || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    if (lastModified) res.setHeader('Last-Modified', lastModified);
    if (fileInfo.length) res.setHeader('Content-Length', fileInfo.length.toString());

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    const stream = await getReadStream(fileId);
    stream.on('error', (err) => {
      console.error('Stream error', err);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Failed to read file', err);
    if (!res.headersSent) safeJson(res, { error: 'File not found.' }, 404);
  }
};

app.get('/api/files/:fileId', fileHandler);
app.head('/api/files/:fileId', fileHandler);

// Serve the built Vite app in production (Render, etc.)
const clientBuildDir = path.resolve(process.cwd(), 'build');
const clientIndexHtml = path.join(clientBuildDir, 'index.html');
if (fs.existsSync(clientIndexHtml)) {
  app.use(express.static(clientBuildDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(clientIndexHtml);
  });
}

app
  .listen(port)
  .once('listening', () => {
    console.log(
      `[server] PID=${process.pid} listening on http://localhost:${port} | cwd=${process.cwd()} | loadedRootEnv=${loadedRootEnv} | loadedServerEnv=${loadedServerEnv} | maskedKey=${GEMINI_KEY.length >= 8 ? `${GEMINI_KEY.slice(0, 4)}...${GEMINI_KEY.slice(-4)}` : '(too short)'
      } | model=gemini-2.5-flash-image`
    );
  })
  .on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`[server] Port ${port} is already in use. Stop the other process and retry.`);
      process.exit(1);
    }
    throw err;
  });
