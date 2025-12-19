import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type AssetInfo = {
  id: string;
  ownerId: string;
  path: string;
  mime: string;
  size: number;
  createdAt: number;
  lastUsedAt: number;
};

const ASSET_DIR = path.join(os.tmpdir(), 'ai-designer-video-assets');
const ASSET_TTL_MS = 8 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

const assetStore = new Map<string, AssetInfo>();

async function ensureAssetDir() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
}

function extensionForMime(mime: string) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

export async function saveUploadedAsset(file: Express.Multer.File, ownerId: string) {
  await ensureAssetDir();
  const id = randomUUID();
  const ext = extensionForMime(file.mimetype);
  const filePath = path.join(ASSET_DIR, `${id}.${ext}`);
  if (typeof (file as any).path === 'string' && (file as any).path) {
    await fs.rename((file as any).path, filePath);
  } else {
    await fs.writeFile(filePath, file.buffer);
  }
  const now = Date.now();
  const info: AssetInfo = {
    id,
    ownerId,
    path: filePath,
    mime: file.mimetype,
    size: file.size,
    createdAt: now,
    lastUsedAt: now,
  };
  assetStore.set(id, info);
  return { assetId: id, path: filePath, mime: file.mimetype, size: file.size };
}

export function getAssetInfo(id: string, ownerId?: string) {
  const info = assetStore.get(id);
  if (!info) return undefined;
  if (ownerId && info.ownerId !== ownerId) return undefined;
  if (!fsSync.existsSync(info.path)) {
    assetStore.delete(id);
    return undefined;
  }
  return info;
}

export function touchAsset(id: string) {
  const info = assetStore.get(id);
  if (!info) return;
  info.lastUsedAt = Date.now();
}

export async function deleteAsset(id: string) {
  const info = assetStore.get(id);
  if (!info) return;
  assetStore.delete(id);
  try {
    await fs.rm(info.path, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export async function cleanupAssets() {
  const now = Date.now();
  const removals: string[] = [];
  for (const [id, info] of assetStore.entries()) {
    if (now - info.lastUsedAt > ASSET_TTL_MS) {
      removals.push(id);
    }
  }
  await Promise.all(removals.map((id) => deleteAsset(id)));
}

export function startAssetCleanup() {
  cleanupAssets();
  setInterval(cleanupAssets, CLEANUP_INTERVAL_MS).unref();
}
