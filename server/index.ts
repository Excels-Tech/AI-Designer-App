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
const MAX_EDIT_IMAGE_BYTES = 8 * 1024 * 1024;
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
app.use('/api/image/edit', jsonLarge);
app.use('/api/image/edit-views', jsonLarge);
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
  const normalizedComposite = normalizePngInput(composite);
  if (!normalizedComposite) return { ok: false, error: 'Composite must be a PNG data URL.' };
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
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
    }
    assertDataUrlSize(imageDataUrl);

    const response = await fetchWithTimeout(
      `${SAM2_SERVICE_URL}/segment/color-layers-dynamic`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl,
          max_colors: maxColors,
          min_area_ratio: minAreaRatio,
          merge_threshold: mergeThreshold,
          seed,
        }),
      },
      20000
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Layer detection failed.',
      });
    }

    return res.json({
      ok: true,
      width: payload?.width,
      height: payload?.height,
      layers: Array.isArray(payload?.layers) ? payload.layers : [],
      sam2: payload?.sam2,
    });
  } catch (err: any) {
    console.error('SAM2 dynamic proxy error:', err);
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
        return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
      }
      assertDataUrlSize(imageDataUrl);

      const fallback = await fallbackKmeansColorLayersDynamic({
        imageDataUrl,
        maxColors,
        minAreaRatio,
        mergeThreshold,
        seed,
      });

      return res.json({
        ok: true,
        width: fallback.width,
        height: fallback.height,
        layers: fallback.layers,
        sam2: { mode: 'node-kmeans-dynamic', available: false, modelLoaded: false, used: false },
      });
    } catch (fallbackErr: any) {
      const message =
        err?.name === 'AbortError'
          ? 'SAM2 service timed out. Run `npm run dev:all` or start `sam2_service`.'
          : String(err?.message || err) === 'fetch failed'
            ? 'SAM2 service is offline. Run `npm run dev:all` or start `sam2_service`.'
            : err?.message || 'Failed to reach SAM2 service.';
      const details = fallbackErr?.message ? ` Fallback also failed: ${fallbackErr.message}` : '';
      return res.status(502).json({ ok: false, error: `${message}${details}`.trim() });
    }
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
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
    }
    assertDataUrlSize(imageDataUrl);

    const response = await fetchWithTimeout(`${SAM2_SERVICE_URL}/segment/color-layers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, num_layers: numLayers, min_area_ratio: minAreaRatio, blur, seed }),
    }, 20000);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Layer detection failed. Try a simpler image or increase contrast.',
      });
    }

    res.json({
      ok: true,
      width: payload?.width,
      height: payload?.height,
      layers: Array.isArray(payload?.layers) ? payload.layers : [],
      sam2: payload?.sam2,
    });
  } catch (err: any) {
    console.error('SAM2 proxy error:', err);
    try {
      const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
      const rawNumLayers = Number(req.body?.num_layers ?? req.body?.numLayers ?? 4);
      const numLayers = Number.isFinite(rawNumLayers) ? Math.min(Math.max(rawNumLayers, 2), 8) : 4;
      const rawBlur = Number(req.body?.blur ?? 1);
      const blur = Number.isFinite(rawBlur) ? Math.min(Math.max(Math.round(rawBlur), 0), 9) : 1;
      const rawSeed = Number(req.body?.seed ?? 42);
      const seed = Number.isFinite(rawSeed) ? Math.round(rawSeed) : 42;

      if (!isImageDataUrl(imageDataUrl)) {
        return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
      }
      assertDataUrlSize(imageDataUrl);

      const fallback = await fallbackKmeansColorLayers({ imageDataUrl, numLayers, blur, seed });
      return res.json({
        ok: true,
        width: fallback.width,
        height: fallback.height,
        layers: fallback.layers,
        sam2: { mode: 'node-kmeans', available: false, modelLoaded: false, used: false },
      });
    } catch (fallbackErr: any) {
      const message =
        err?.name === 'AbortError'
          ? 'SAM2 service timed out. Run `npm run dev:all` or start `sam2_service`.'
          : String(err?.message || err) === 'fetch failed'
            ? 'SAM2 service is offline. Run `npm run dev:all` or start `sam2_service`.'
            : err?.message || 'Failed to reach SAM2 service.';
      const details = fallbackErr?.message ? ` Fallback also failed: ${fallbackErr.message}` : '';
      return res.status(502).json({ ok: false, error: `${message}${details}`.trim() });
    }
  }
});

app.post('/api/sam2/auto', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    if (!isImageDataUrl(imageDataUrl)) {
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
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

    res.json({ ok: true, masks: Array.isArray(payload?.masks) ? payload.masks : [] });
  } catch (err: any) {
    console.error('SAM2 auto proxy error:', err);
    const message = err?.name === 'AbortError'
      ? 'SAM2 service timed out. Is the Python service running?'
      : err?.message || 'Failed to reach SAM2 service.';
    res.status(502).json({ ok: false, error: message });
  }
});

app.post('/api/sam2/object-from-point', async (req: Request, res: Response) => {
  try {
    const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);

    if (!isImageDataUrl(imageDataUrl)) {
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      return res.status(400).json({ ok: false, error: 'x and y must be normalized coordinates (0..1).' });
    }
    assertDataUrlSize(imageDataUrl);

    const response = await fetchWithTimeout(
      `${SAM2_SERVICE_URL}/segment/object-from-point`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, x, y }),
      },
      20000
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Object selection failed.',
      });
    }

    res.json({ ok: true, objectMaskDataUrl: payload?.objectMaskDataUrl });
  } catch (err: any) {
    console.error('SAM2 object-from-point proxy error:', err);
    try {
      const imageDataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
      const x = Number(req.body?.x);
      const y = Number(req.body?.y);
      if (!isImageDataUrl(imageDataUrl)) {
        return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return res.status(400).json({ ok: false, error: 'x and y must be normalized coordinates (0..1).' });
      }
      assertDataUrlSize(imageDataUrl);
      const objectMaskDataUrl = await fallbackObjectMaskFromPoint({ imageDataUrl, x, y });
      return res.json({ ok: true, objectMaskDataUrl, sam2: { mode: 'node-region-grow', used: false } });
    } catch (fallbackErr: any) {
      const message =
        err?.name === 'AbortError'
          ? 'SAM2 service timed out. Run `npm run dev:all` or start `sam2_service`.'
          : String(err?.message || err) === 'fetch failed'
            ? 'SAM2 service is offline. Run `npm run dev:all` or start `sam2_service`.'
            : err?.message || 'Failed to reach SAM2 service.';
      const details = fallbackErr?.message ? ` Fallback also failed: ${fallbackErr.message}` : '';
      return res.status(502).json({ ok: false, error: `${message}${details}`.trim() });
    }
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
      return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
    }
    if (!isPngDataUrl(objectMaskDataUrl)) {
      return res.status(400).json({ ok: false, error: 'objectMaskDataUrl must be a PNG data URL.' });
    }
    assertDataUrlSize(imageDataUrl);
    assertDataUrlSize(objectMaskDataUrl);

    const response = await fetchWithTimeout(
      `${SAM2_SERVICE_URL}/segment/split-colors-in-mask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, objectMaskDataUrl, max_colors: maxColors, min_area_ratio: minAreaRatio, seed }),
      },
      30000
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: payload?.detail || payload?.error || 'Color splitting failed.',
      });
    }

    res.json({ ok: true, layers: Array.isArray(payload?.layers) ? payload.layers : [] });
  } catch (err: any) {
    console.error('SAM2 split-colors-in-mask proxy error:', err);
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
        return res.status(400).json({ ok: false, error: 'imageDataUrl must be a PNG or JPEG data URL.' });
      }
      if (!isPngDataUrl(objectMaskDataUrl)) {
        return res.status(400).json({ ok: false, error: 'objectMaskDataUrl must be a PNG data URL.' });
      }
      assertDataUrlSize(imageDataUrl);
      assertDataUrlSize(objectMaskDataUrl);

      const layers = await fallbackSplitColorsInMask({
        imageDataUrl,
        objectMaskDataUrl,
        maxColors,
        minAreaRatio,
        seed,
      });
      return res.json({ ok: true, layers, sam2: { mode: 'node-kmeans', used: false } });
    } catch (fallbackErr: any) {
      const message =
        err?.name === 'AbortError'
          ? 'SAM2 service timed out. Run `npm run dev:all` or start `sam2_service`.'
          : String(err?.message || err) === 'fetch failed'
            ? 'SAM2 service is offline. Run `npm run dev:all` or start `sam2_service`.'
            : err?.message || 'Failed to reach SAM2 service.';
      const details = fallbackErr?.message ? ` Fallback also failed: ${fallbackErr.message}` : '';
      return res.status(502).json({ ok: false, error: `${message}${details}`.trim() });
    }
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
      return res.status(400).json({ error: 'imageDataUrl must be a data:image/* data URL.' });
    }
    if (!isImageDataUrl(imageDataUrl)) {
      return res.status(400).json({ error: 'imageDataUrl must be a PNG, JPG, or WEBP data URL.' });
    }
    assertEditDataUrlSize(imageDataUrl);

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
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
    res.json({ imageDataUrl: `data:image/png;base64,${cropped.toString('base64')}` });
  } catch (err: any) {
    console.error('Image edit error:', err);
    res.status(500).json({ error: mapGeminiError(err) });
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
      return res.status(400).json({ error: 'imageDataUrl must be a data:image/* data URL.' });
    }
    if (!isImageDataUrl(imageDataUrl)) {
      return res.status(400).json({ error: 'imageDataUrl must be a PNG, JPG, or WEBP data URL.' });
    }
    assertEditDataUrlSize(imageDataUrl);

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
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
      return res.status(400).json({ error: 'requests is required (at least 1).' });
    }
    if (requestsRaw.length > 4) {
      return res.status(400).json({ error: 'Maximum 4 requests are allowed.' });
    }

    const normalizedRequests: EditViewRequest[] = [];
    const seenViews = new Set<EditViewKey>();
    for (const raw of requestsRaw) {
      const view = typeof raw?.view === 'string' ? raw.view.trim().toLowerCase() : '';
      const styleValue = typeof raw?.style === 'string' ? raw.style.trim() : '';
      const modelValue = typeof raw?.model === 'string' ? raw.model.trim() : '';
      const resolutionValue = typeof raw?.resolution === 'string' ? raw.resolution.trim() : '';

      if (!allowedEditViews.has(view as EditViewKey)) {
        return res.status(400).json({ error: 'Invalid view value in requests.' });
      }
      const viewKey = view as EditViewKey;
      if (seenViews.has(viewKey)) {
        return res.status(400).json({ error: 'Duplicate view entries are not allowed.' });
      }
      seenViews.add(viewKey);

      if (!styleValue) {
        return res.status(400).json({ error: 'Each request must include a style.' });
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

    res.json({ results });
  } catch (err: any) {
    console.error('Image edit-views error:', err);
    res.status(500).json({ error: mapGeminiError(err) });
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

    const compositeDataUrl = await resolvePngInputToDataUrl(validation.data.composite);
    const imageDataUrls = await Promise.all(validation.data.images.map((img: any) => resolvePngInputToDataUrl(img)));

    const compositeFileId = await uploadDataUrlToGridFS(compositeDataUrl, `composite-${Date.now()}.png`);
    const imageFileIds = await Promise.all(
      imageDataUrls.map((dataUrl, idx) =>
        uploadDataUrlToGridFS(dataUrl, `${validation.data.images[idx]?.view || idx}-${Date.now()}.png`)
      )
    );

    const doc = await Design.create({
      ...validation.data,
      composite: { mime: 'image/png', fileId: compositeFileId.toString() },
      images: validation.data.images.map((img: any, idx: number) => ({
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
        ...doc.images.map((img: any) => img.fileId).filter(Boolean),
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
  const userId =
    ((req.headers['x-user-id'] as string | undefined)?.trim() ||
      (typeof req.query.uid === 'string' ? req.query.uid.trim() : '')) ??
    '';
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
