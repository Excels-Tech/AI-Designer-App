import fs from 'fs';
import path from 'path';

// Allow overriding the uploads root so platforms like Render
// can mount a persistent disk (for example at /var/data/uploads).
export const uploadsRoot =
  process.env.UPLOADS_ROOT || path.join(process.cwd(), 'uploads');

export function ensureUploadsDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) {
    throw new Error('Invalid data URL');
  }
  const mime = match[1];
  const data = match[2];
  return { mime, buffer: Buffer.from(data, 'base64') };
}

export function writeDataUrlToFile(dataUrl: string, filePath: string) {
  const { buffer } = decodeDataUrl(dataUrl);
  ensureUploadsDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buffer);
}

export function buildPublicUrl(filePath: string) {
  const relative = path.relative(process.cwd(), filePath);
  return '/' + relative.replace(/\\/g, '/');
}
