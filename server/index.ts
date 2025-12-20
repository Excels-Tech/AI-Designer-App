import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const rootEnv = path.resolve(process.cwd(), '.env');
const serverEnv = path.resolve(process.cwd(), 'server', '.env');

if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
if (fs.existsSync(serverEnv)) dotenv.config({ path: serverEnv });

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

type StyleKey = 'realistic' | '3d' | 'lineart' | 'watercolor' | 'modelMale' | 'modelFemale' | 'modelKid';
type ViewKey = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'top';

interface GenerateRequestBody {
  prompt?: string;
  style?: StyleKey;
  views?: ViewKey[];
  resolution?: number;
  autoSave?: boolean;
  title?: string;
}

function sanitizeKey(v?: string) {
  return (v ?? '')
    .trim()
    .replace(/\r?\n/g, '')
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
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
  top: 'Top View',
};

const allowedResolutions = new Set([512, 1024, 1536, 2048]);
const port = Number(process.env.PORT || 4000);
const SAM2_SERVICE_URL = process.env.SAM2_SERVICE_URL || 'http://127.0.0.1:8008';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_SLIDES = 20;
const MAX_VIDEO_UPLOAD_BYTES = 12 * 1024 * 1024;

const app = express();
const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, '');
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => normalizeOrigin(origin.trim()))
  .filter(Boolean);
if (allowedOrigins.length) {
  allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173');
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
app.use('/api/sam2', jsonLarge);
app.use(jsonSmall);

startAssetCleanup();

function mapGeminiError(err: any) {
  const msg = String(err?.message || err);

  if (msg.includes('API key not valid') || msg.includes('PERMISSION_DENIED')) {
    return 'Gemini API key is invalid or lacks permission.';
  }

  if (msg.includes('model') && msg.includes('not found')) {
    return 'Gemini model is unavailable.';
  }

  if (msg.toLowerCase().includes('quota')) {
    return 'Gemini quota exceeded.';
  }

  return 'Gemini request failed. Check server logs.';
}

connectMongo().catch((err) => {
  console.error('Failed to connect to MongoDB', err);
  process.exit(1);
});

const allowedStyles: StyleKey[] = ['realistic', '3d', 'lineart', 'watercolor', 'modelMale', 'modelFemale', 'modelKid'];
const allowedViews = new Set<ViewKey>(['front', 'back', 'left', 'right', 'threeQuarter', 'top']);

const pngDataUrlRegex = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/i;

function isPngDataUrl(value: unknown) {
  return typeof value === 'string' && pngDataUrlRegex.test(value.trim());
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

  if (!prompt) return { ok: false, error: 'Prompt is required.' };
  if (!name || name.length > 60) return { ok: false, error: 'Name is required (max 60 chars).' };
  if (!userId) return { ok: false, error: 'Missing user id.' };
  if (!allowedStyles.includes(style)) return { ok: false, error: 'Invalid style.' };
  if (!allowedResolutions.has(resolution)) return { ok: false, error: 'Invalid resolution.' };
  if (!views.length) return { ok: false, error: 'At least one view is required.' };
  if (new Set(views).size !== views.length) return { ok: false, error: 'Views must be unique.' };
  if (!views.every((v) => allowedViews.has(v))) return { ok: false, error: 'Invalid view value.' };
  if (views.length > 6) return { ok: false, error: 'Maximum 6 views allowed.' };
  if (!isPngDataUrl(composite) && typeof composite !== 'object') {
    return { ok: false, error: 'Composite must be a PNG data URL.' };
  }
  if (images.length !== views.length) return { ok: false, error: 'Images must match number of views.' };

  const normalizedImages = images.map((img: any) => ({
    view: img?.view,
    mime: 'image/png' as const,
    dataUrl: typeof img?.src === 'string' ? img.src : img?.dataUrl,
  }));

  if (!normalizedImages.every((img) => typeof img.view === 'string' && isPngDataUrl(img.dataUrl))) {
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
      composite: { mime: 'image/png' as const, dataUrl: composite },
      images: normalizedImages.map((img) => ({ view: img.view, mime: 'image/png' as const, dataUrl: img.dataUrl })),
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

function dataUrlToInlineData(dataUrl: string) {
  const match = /^data:(image\/png);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid data URL');
  }
  return { mimeType: match[1], data: match[2] };
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
    data.images.map((img, idx) => uploadDataUrlToGridFS(img.src, `${img.view || idx}-${Date.now()}.png`))
  );

  const doc = await Design.create({
    ...validation.data,
    name: validation.data.name,
    title: validation.data.name,
    composite: { mime: 'image/png', fileId: compositeFileId.toString() },
    images: data.images.map((img, idx) => ({
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
  top: 'STRICT: Top-down overhead view. Camera directly above. Show the top view only.',
};

function buildViewPrompt(basePrompt: string, style: StyleKey, view: ViewKey, width: number, height: number) {
  return [
    `Single-frame image of the SAME product/design viewed from the ${viewLabels[view]} angle.`,
    `View requirement: ${viewSpecificInstructions[view]}`,
    `No grids, no collages, no multi-panel layouts. One centered subject on a neutral studio background.`,
    `Ensure the entire product is fully visible in frame with comfortable margins; no parts cut off by the image edges.`,
    `Keep lighting, materials, and colors identical to every other view.`,
    `Do not mirror or flip the subject. Do not swap left/right. Each requested view must be distinct and match its angle.`,
    `Style: ${styleModifiers[style]}.`,
    `Base prompt: ${basePrompt}`,
    `Target output size close to ${width}x${height}px (square crop friendly).`,
  ].join(' ');
}

async function generateViewImage(
  prompt: string,
  style: StyleKey,
  view: ViewKey,
  targetWidth: number,
  targetHeight: number
) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: buildViewPrompt(prompt, style, view, targetWidth, targetHeight),
  });

  const parts = (response as any)?.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((part: any) => part.inlineData?.data)?.inlineData;

  if (!imagePart?.data) {
    throw new Error(`Gemini response did not include an image for view "${view}".`);
  }

  const raw = Buffer.from(imagePart.data as string, 'base64');
  const background = { r: 245, g: 246, b: 248, alpha: 1 };
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

async function composeComposite(
  tiles: { view: ViewKey; buffer: Buffer }[],
  columns: number,
  rows: number,
  tileWidth: number,
  tileHeight: number
) {
  const canvas = sharp({
    create: {
      width: columns * tileWidth,
      height: rows * tileHeight,
      channels: 4,
      background: { r: 245, g: 246, b: 248, alpha: 1 },
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
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  if (!style || !(style in styleModifiers)) {
    return res.status(400).json({ error: 'Invalid style. Allowed: realistic, 3d, lineart, watercolor.' });
  }

  if (!Array.isArray(views) || views.length < 1) {
    return res.status(400).json({ error: 'At least one view must be selected.' });
  }

  const unknownView = views.find((v) => !(v in viewLabels));
  if (unknownView) {
    return res.status(400).json({ error: `Invalid view: ${unknownView}` });
  }

  if (!resolution || !allowedResolutions.has(resolution)) {
    return res.status(400).json({ error: `Invalid resolution. Allowed: ${Array.from(allowedResolutions).join(', ')}` });
  }

  if (autoSave && (!userId || !userId.trim())) {
    return res.status(401).json({ error: 'Missing user id' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  try {
    const grid = computeGrid(views.length);
    const tileWidth = Math.max(64, Math.floor(resolution / grid.columns));
    const tileHeight = Math.max(64, Math.floor(resolution / grid.rows));

    const tiles = await Promise.all(
      views.map((view) => generateViewImage(prompt.trim(), style, view, tileWidth, tileHeight))
    );

    const composite = await composeComposite(tiles, grid.columns, grid.rows, tileWidth, tileHeight);

    let designId: string | undefined;

    if (autoSave) {
      designId = await saveDesign({
        title,
        userId: userId!.trim(),
        prompt: prompt.trim(),
        style,
        resolution,
        views,
        composite: composite.dataUrl,
        images: tiles.map((tile) => ({ view: tile.view, src: tile.dataUrl })),
      });
    }

    res.json({
      composite: composite.dataUrl,
      images: tiles.map((tile) => ({
        view: tile.view,
        src: tile.dataUrl,
      })),
      compositePngBase64: composite.buffer.toString('base64'),
      parts: tiles.map((tile) => ({
        view: tile.view,
        base64: tile.dataUrl.replace(/^data:image\/png;base64,/, ''),
      })),
      meta: {
        dimensions: composite.dimensions,
        grid: { ...grid, tileWidth, tileHeight },
        viewOrder: views,
      },
      designId,
    });
  } catch (err: any) {
    console.error('Gemini error:', err);
    res.status(500).json({ error: mapGeminiError(err) });
  }
});

app.get('/api/sam2/health', async (_req: Request, res: Response) => {
  try {
    const response = await fetchWithTimeout(`${SAM2_SERVICE_URL}/health`, {}, 5000);
    const payload = await response.json().catch(() => ({}));
    res.status(response.ok ? 200 : 500).json(payload);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'SAM2 service offline' });
  }
});

app.post('/api/sam2/color-layers', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const rawNumLayers = Number(req.body?.num_layers ?? 4);
    const numLayers = Number.isFinite(rawNumLayers) ? Math.min(Math.max(rawNumLayers, 2), 8) : 4;

    if (!isPngDataUrl(imageDataUrl)) {
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG data URL.' });
    }
    assertDataUrlSize(imageDataUrl);

    const response = await fetchWithTimeout(`${SAM2_SERVICE_URL}/segment/color-layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, num_layers: numLayers }),
    }, 20000);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Layer detection failed. Try a simpler image or increase contrast.',
      });
    }

    res.json(payload);
  } catch (err: any) {
    console.error('SAM2 proxy error:', err);
    const message = err?.name === 'AbortError'
      ? 'SAM2 service timed out. Is the Python service running?'
      : err?.message || 'Failed to reach SAM2 service.';
    res.status(502).json({ ok: false, error: message });
  }
});

app.post('/api/sam2/auto', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    if (!isPngDataUrl(imageDataUrl)) {
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG data URL.' });
    }
    assertDataUrlSize(imageDataUrl);

    const response = await fetchWithTimeout(`${SAM2_SERVICE_URL}/segment/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    }, 20000);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Automatic segmentation failed.',
      });
    }

    res.json(payload);
  } catch (err: any) {
    console.error('SAM2 auto proxy error:', err);
    const message = err?.name === 'AbortError'
      ? 'SAM2 service timed out. Is the Python service running?'
      : err?.message || 'Failed to reach SAM2 service.';
    res.status(502).json({ ok: false, error: message });
  }
});

app.post('/api/realistic/render', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

    if (!isPngDataUrl(imageDataUrl)) {
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG data URL.' });
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

    res.json({ imageDataUrl: `data:image/png;base64,${imagePart.data}` });
  } catch (err: any) {
    console.error('Realistic render error:', err);
    res.status(500).json({ ok: false, error: mapGeminiError(err) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const validation = validateDesignPayload({ ...req.body, userId });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const compositeFileId = await uploadDataUrlToGridFS(validation.data.composite.dataUrl!, `composite-${Date.now()}.png`);
    const imageFileIds = await Promise.all(
      validation.data.images.map((img, idx) => uploadDataUrlToGridFS(img.dataUrl!, `${img.view || idx}-${Date.now()}.png`))
    );

    const doc = await Design.create({
      ...validation.data,
      composite: { mime: 'image/png', fileId: compositeFileId.toString() },
      images: validation.data.images.map((img, idx) => ({
        view: img.view,
        mime: img.mime,
        fileId: imageFileIds[idx].toString(),
      })),
    });
    res.json({ id: doc._id.toString() });
  } catch (err) {
    console.error('Failed to save design', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save design.' });
  }
});

app.get('/api/designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });
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

    res.json({ items, nextCursor });
  } catch (err) {
    console.error('Failed to list designs', err);
    res.status(500).json({ error: 'Failed to load designs.' });
  }
});

app.get('/api/designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid design id.' });
    }

    const doc = await Design.findOne({ _id: id, userId });
    if (!doc) {
      return res.status(404).json({ error: 'Design not found.' });
    }

    res.json({
      id: doc._id.toString(),
      name: doc.name || doc.title,
      title: doc.title || doc.name,
      prompt: doc.prompt,
      style: doc.style,
      resolution: doc.resolution,
      views: doc.views,
      composite: {
        mime: doc.composite.mime,
        url: buildFileUrl(doc.composite.fileId),
        dataUrl: doc.composite.dataUrl,
      },
      images: doc.images.map((img) => ({
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
    res.status(500).json({ error: 'Failed to load design.' });
  }
});

app.delete('/api/designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid design id.' });
    }
    const doc = await Design.findOneAndDelete({ _id: id, userId });
    if (doc) {
      const fileIds = [
        doc.composite?.fileId,
        ...doc.images.map((img) => img.fileId).filter(Boolean),
      ].filter(Boolean) as string[];
      await Promise.all(fileIds.map((fid) => deleteGridFSFile(fid)));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete design', err);
    res.status(500).json({ error: 'Failed to delete design.' });
  }
});

app.get('/api/designs/:id/download.zip', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid design id.' });
    }

    const doc = await Design.findOne({ _id: id, userId });
    if (!doc) {
      return res.status(404).json({ error: 'Design not found.' });
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

    // Composite
    if (doc.composite.fileId) {
      const stream = await getReadStream(doc.composite.fileId);
      archive.append(stream, { name: 'composite.png' });
    } else if (doc.composite.dataUrl) {
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
      res.status(500).json({ error: 'Failed to download zip.' });
    }
  }
});

app.post('/api/video/render', jsonLarge, async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const project = req.body?.project;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const jobId = await createVideoJob(project, userId, baseUrl);
    res.json({ jobId });
  } catch (err: any) {
    console.error('Video render failed', err);
    res.status(400).json({ error: err?.message || 'Failed to render video.' });
  }
});

app.get('/api/video/status/:id', (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  const job = getVideoJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.userId && job.userId !== userId) return res.status(404).json({ error: 'Job not found.' });
  res.json({ status: job.status, error: job.error, progress: job.progress });
});

app.get('/api/video/download/:id', (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  const { id } = req.params;
  const job = getVideoJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.userId && job.userId !== userId) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done' || !hasJobOutput(id)) {
    return res.status(409).json({ error: 'Video not ready.' });
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
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const title = String(req.body?.title || '').trim();
    const jobId = String(req.body?.jobId || '').trim();
    const project = req.body?.project;

    if (!title) return res.status(400).json({ error: 'Missing title.' });
    if (title.length > 80) return res.status(400).json({ error: 'Title is too long.' });
    if (!jobId) return res.status(400).json({ error: 'Missing jobId.' });

    const job = getVideoJob(jobId);
    if (!job || (job.userId && job.userId !== userId)) {
      return res.status(404).json({ error: 'Job not found.' });
    }
    if (job.status !== 'done' || !hasJobOutput(jobId)) {
      return res.status(409).json({ error: 'Video not ready.' });
    }

    const outputPath = getJobOutputPath(jobId)!;
    const videoFileId = await uploadFileToGridFS(outputPath, `video-${Date.now()}.mp4`, 'video/mp4');

    const doc = await VideoDesign.create({
      title,
      userId,
      video: { mime: 'video/mp4', fileId: videoFileId.toString() },
      project,
    });

    res.json({
      id: doc._id.toString(),
      title: doc.title,
      downloadUrl: `/api/video-designs/${doc._id.toString()}/download.mp4`,
    });
  } catch (err: any) {
    console.error('Failed to save video design', err);
    res.status(500).json({ error: err?.message || 'Failed to save video.' });
  }
});

app.get('/api/video-designs', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

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
    res.json({ items, nextCursor });
  } catch (err) {
    console.error('Failed to list video designs', err);
    res.status(500).json({ error: 'Failed to load videos.' });
  }
});

app.get('/api/video-designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid video id.' });
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return res.status(404).json({ error: 'Video not found.' });

    res.json({
      id: doc._id.toString(),
      title: doc.title,
      createdAt: doc.createdAt,
      downloadUrl: `/api/video-designs/${doc._id.toString()}/download.mp4`,
    });
  } catch (err) {
    console.error('Failed to fetch video design', err);
    res.status(500).json({ error: 'Failed to load video.' });
  }
});

app.delete('/api/video-designs/:id', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid video id.' });
    }

    const doc = await VideoDesign.findOneAndDelete({ _id: id, userId });
    if (doc?.video?.fileId) {
      await deleteGridFSFile(doc.video.fileId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete video design', err);
    res.status(500).json({ error: 'Failed to delete video.' });
  }
});

app.get('/api/video-designs/:id/download.mp4', async (req, res) => {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid video id.' });
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return res.status(404).json({ error: 'Video not found.' });

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
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download video.' });
  }
});

app.get('/api/video-designs/:id/stream.mp4', async (req, res) => {
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid video id.' });
    }

    const doc = await VideoDesign.findOne({ _id: id, userId });
    if (!doc) return res.status(404).json({ error: 'Video not found.' });

    const fileInfo = await getFileInfo(doc.video.fileId);
    if (!fileInfo) return res.status(404).json({ error: 'Video file not found.' });

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
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream video.' });
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
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  try {
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded.' });
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
    res.json({ assets });
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
    res.status(400).json({ error: err?.message || 'Upload failed.' });
  }
});

app.get('/api/video/assets/:id', (req, res) => {
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
  if (!userId) return res.status(401).json({ error: 'Missing user id' });

  const info = getAssetInfo(req.params.id, userId);
  if (!info) return res.status(404).json({ error: 'Asset not found.' });
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
    if (!userId) return res.status(401).json({ error: 'Missing user id' });

    const { fileId } = req.params;
    if (!Types.ObjectId.isValid(fileId)) return res.status(400).json({ error: 'Invalid file id.' });
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
      return res.status(404).json({ error: 'File not found.' });
    }

    const fileInfo = await getFileInfo(fileId);
    if (!fileInfo) return res.status(404).json({ error: 'File not found.' });

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
    if (!res.headersSent) res.status(404).json({ error: 'File not found.' });
  }
});

app.use((err: any, _req: Request, res: Response, next: () => void) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB).` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ error: `Too many files (max ${MAX_VIDEO_SLIDES}).` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err?.message?.includes('Only PNG')) {
    return res.status(415).json({ error: err.message });
  }
  next();
});

app.get('/api/ping-db', async (_req, res) => {
  try {
    const db = await getDb();
    const info = await db.admin().serverInfo();
    res.json({ ok: true, version: info.version });
  } catch (err) {
    console.error('Mongo ping failed', err);
    res.status(500).json({ ok: false, error: 'Mongo unavailable' });
  }
});

app.get('/api/health/gemini-key', (_req, res) => {
  res.json({
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
    if (!userId) return res.status(401).json({ error: 'Missing user id' });

    const { fileId } = req.params;
    if (!Types.ObjectId.isValid(fileId)) return res.status(400).json({ error: 'Invalid file id.' });

    const owner = await Design.findOne({
      userId,
      $or: [{ 'composite.fileId': fileId }, { 'images.fileId': fileId }],
    }).select({ _id: 1 });
    if (!owner) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const fileInfo = await getFileInfo(fileId);
    if (!fileInfo) return res.status(404).json({ error: 'File not found.' });

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
    if (!res.headersSent) res.status(404).json({ error: 'File not found.' });
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
      `[server] PID=${process.pid} listening on http://localhost:${port} | cwd=${process.cwd()} | loadedRootEnv=${loadedRootEnv} | loadedServerEnv=${loadedServerEnv} | maskedKey=${
        GEMINI_KEY.length >= 8 ? `${GEMINI_KEY.slice(0, 4)}...${GEMINI_KEY.slice(-4)}` : '(too short)'
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
