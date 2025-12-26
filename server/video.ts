import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getAssetInfo, touchAsset } from './videoAssets';
import ffmpegPath from 'ffmpeg-static';

type SlideInput = {
  imageSrc: string;
  assetId?: string;
  durationSec: number;
  overlayText: string;
  overlayColorHex?: string;
  fontStyle: 'modern' | 'classic' | 'bold' | 'script';
  fontSizePx: number;
  position: 'top' | 'center' | 'bottom' | 'custom';
  xPct?: number;
  yPct?: number;
  animation: 'fadeIn' | 'slide' | 'zoom' | 'rotate' | 'none';
};

export type VideoProjectInput = {
  id: string;
  quality: '720p' | '1080p';
  format: 'mp4';
  fps: number;
  slides: SlideInput[];
  width?: number;
  height?: number;
};

type VideoJob = {
  id: string;
  userId?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  outputPath?: string;
  workDir?: string;
  progress?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

const jobStore = new Map<string, VideoJob>();

const QUALITY_MAP = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

const FONT_DIR = path.resolve(__dirname, 'assets', 'fonts');
const FONT_MAP: Record<string, string> = {
  modern: path.join(FONT_DIR, 'Inter-Regular.ttf'),
  classic: path.join(FONT_DIR, 'IBMPlexSerif-Regular.ttf'),
  bold: path.join(FONT_DIR, 'Inter-Bold.ttf'),
  script: path.join(FONT_DIR, 'Pacifico-Regular.ttf'),
};

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_SLIDES = 20;
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_JOBS = 20;
const ALLOWED_FPS = new Set([12, 24, 30, 60]);

const isValidHexColor = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());

const ffmpegColor = (value: unknown) => {
  if (!value) return 'white';
  if (!isValidHexColor(value)) {
    throw new Error('Invalid text color.');
  }
  return `0x${(value as string).trim().slice(1)}`;
};

const escapeDrawtext = (text: string) =>
  text
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');

const escapeDrawtextFilePath = (filePath: string) =>
  filePath
    .replace(/\\/g, '/')
    // drawtext options are `:`-separated, so Windows drive letters must escape `:` (e.g. `C\:/...`)
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,');

const ensureTempDir = async () => {
  const base = path.join(os.tmpdir(), 'ai-designer-video');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'job-'));
};

const isPrivateIp = (address: string) => {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map((v) => Number(v));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    );
  }
  return false;
};

const isBlockedHostname = (hostname: string) => {
  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost') return true;
  if (lowered.endsWith('.local')) return true;
  return false;
};

const assertSafeRemoteUrl = async (url: URL) => {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are allowed.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error('Blocked host.');
  }
  const ip = net.isIP(url.hostname) ? url.hostname : (await dns.lookup(url.hostname)).address;
  if (isPrivateIp(ip)) {
    throw new Error('Blocked host.');
  }
};

const MAX_REDIRECT_HOPS = 1;
const fetchImageToFile = async (
  url: string,
  dir: string,
  index: number,
  userId?: string,
  baseUrl?: string,
  redirectHops = 0,
  internalOrigin?: string
) => {
  const target = url.startsWith('/') && baseUrl ? `${baseUrl}${url}` : url;
  const parsed = new URL(target);
  const baseOrigin = internalOrigin ?? (baseUrl ? new URL(baseUrl).origin : undefined);
  const isInternalRequest = Boolean(internalOrigin || (url.startsWith('/') && baseUrl));

  if (!isInternalRequest) {
    await assertSafeRemoteUrl(parsed);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(target, {
      headers: userId ? { 'x-user-id': userId } : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      throw new Error('Image download timed out.');
    }
    throw err;
  }

  if (res.status >= 300 && res.status < 400) {
    clearTimeout(timeout);
    if (redirectHops >= MAX_REDIRECT_HOPS) {
      throw new Error('Too many redirects.');
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new Error('Redirect missing location header.');
    }
    const nextUrl = new URL(location, parsed);
    const nextInternalOrigin = baseOrigin && nextUrl.origin === baseOrigin ? baseOrigin : undefined;
    if (!nextInternalOrigin) {
      await assertSafeRemoteUrl(nextUrl);
    }
    return fetchImageToFile(
      nextUrl.toString(),
      dir,
      index,
      userId,
      baseUrl,
      redirectHops + 1,
      nextInternalOrigin
    );
  }

  if (!res.ok) {
    clearTimeout(timeout);
    throw new Error(`Failed to download image (${res.status}).`);
  }
  const contentType = res.headers.get('content-type')?.split(';')[0].toLowerCase() || '';
  if (!ALLOWED_MIME.has(contentType)) {
    clearTimeout(timeout);
    throw new Error('Unsupported image type.');
  }
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_IMAGE_BYTES) {
    clearTimeout(timeout);
    throw new Error('Image too large.');
  }

  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const filePath = path.join(dir, `slide-${index}.${ext}`);

  if (!res.body) {
    clearTimeout(timeout);
    throw new Error('Image download failed.');
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES) {
        controller.abort();
        cb(new Error('Image too large.'));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as any), limiter, fsSync.createWriteStream(filePath));
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Image download timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  return { path: filePath, mime: contentType };
};

const resolveImageToFile = async (
  imageSrc: string,
  assetId: string | undefined,
  dir: string,
  index: number,
  userId?: string,
  baseUrl?: string
) => {
  const assetIdLooksLikeUrl = typeof assetId === 'string' && (assetId.startsWith('/') || /^https?:\/\//i.test(assetId));
  if (assetId && !assetIdLooksLikeUrl) {
    const asset = getAssetInfo(assetId, userId);
    if (asset) {
      touchAsset(assetId);
      return asset.path;
    }
  }

  if (/^data:/i.test(imageSrc)) {
    throw new Error('Image data URLs are not supported for video rendering.');
  }
  if (imageSrc.startsWith('/') && !imageSrc.startsWith('/api/')) {
    throw new Error('Slide image must be an /api/ URL.');
  }
  if (!imageSrc.startsWith('/') && !/^https?:\/\//i.test(imageSrc)) {
    throw new Error('Slide image must be an http/https URL.');
  }

  const downloaded = await fetchImageToFile(imageSrc, dir, index, userId, baseUrl);
  return downloaded.path;
};

const buildSlideFilter = (
  slide: SlideInput,
  width: number,
  height: number,
  fps: number
) => {
  const filters: string[] = [];
  const fontSize = Math.max(18, Math.min(140, Math.round(slide.fontSizePx * (height / 720))));
  const x =
    slide.position === 'custom'
      ? `w*${Math.max(0, Math.min(1, typeof slide.xPct === 'number' && Number.isFinite(slide.xPct) ? slide.xPct : 0.5))}-text_w/2`
      : '(w-text_w)/2';
  const y =
    slide.position === 'custom'
      ? `h*${Math.max(0, Math.min(1, typeof slide.yPct === 'number' && Number.isFinite(slide.yPct) ? slide.yPct : 0.85))}-text_h/2`
      : slide.position === 'top'
      ? 'h*0.1'
      : slide.position === 'bottom'
      ? 'h*0.85-text_h'
      : '(h-text_h)/2';
  const fontFile = escapeDrawtextFilePath(FONT_MAP[slide.fontStyle] || FONT_MAP.modern);

  filters.push(
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1'
  );

  const frames = Math.max(1, Math.round(slide.durationSec * fps));
  const denom = Math.max(1, frames - 1);

  if (slide.animation === 'zoom') {
    const startZoom = 1.0;
    const endZoom = 1.12;
    const step = (endZoom - startZoom) / denom;
    filters.push(
      `zoompan=z='if(eq(on,0),${startZoom.toFixed(3)},min(${endZoom.toFixed(3)},zoom+${step.toFixed(
        6
      )}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`
    );
  } else if (slide.animation === 'slide') {
    const zoom = 1.08;
    filters.push(
      `zoompan=z='${zoom.toFixed(
        3
      )}':x='(iw-iw/zoom)*on/${denom}':y='(ih-ih/zoom)/2':d=${frames}:s=${width}x${height}:fps=${fps}`
    );
  } else {
    filters.push(`fps=${fps}`);
    if (slide.animation === 'rotate') {
      const amp = 0.02;
      filters.push(`rotate=${amp}*sin(2*PI*t/${Math.max(0.01, slide.durationSec)}):ow=iw:oh=ih:c=black`);
    }
  }

  if (slide.overlayText) {
    const color = ffmpegColor(slide.overlayColorHex);
    filters.push(
      `drawtext=fontfile='${fontFile}':text='${escapeDrawtext(
        slide.overlayText
      )}':fontcolor=${color}:fontsize=${fontSize}:x=${x}:y=${y}:box=1:boxcolor=black@0.45:boxborderw=18`
    );
  }

  const shouldFade = slide.animation !== 'none';
  const fadeDur = shouldFade ? Math.min(0.4, Math.max(0, slide.durationSec - 0.2) / 2) : 0;
  if (fadeDur > 0) {
    filters.push(`fade=t=in:st=0:d=${fadeDur}`, `fade=t=out:st=${slide.durationSec - fadeDur}:d=${fadeDur}`);
  }

  filters.push('format=yuv420p');
  return filters.join(',');
};

const runFfmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const bin = ffmpegPath || 'ffmpeg';
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || 'ffmpeg failed.'));
    });
  });

const validateProject = (project: VideoProjectInput) => {
  if (!project || !Array.isArray(project.slides) || project.slides.length === 0) {
    return 'At least one slide is required.';
  }
  if (project.slides.length > MAX_SLIDES) return `Maximum ${MAX_SLIDES} slides allowed.`;
  if (!QUALITY_MAP[project.quality]) return 'Invalid quality.';
  if (project.format !== 'mp4') return 'Only MP4 export is supported.';
  if (typeof project.fps !== 'number' || !Number.isFinite(project.fps) || !ALLOWED_FPS.has(project.fps)) {
    return 'FPS must be one of 12, 24, 30, 60.';
  }
  if (typeof project.width !== 'undefined' || typeof project.height !== 'undefined') {
    if (typeof project.width !== 'number' || typeof project.height !== 'number') {
      return 'Custom size requires both width and height.';
    }
    if (!Number.isFinite(project.width) || !Number.isFinite(project.height)) {
      return 'Invalid custom size.';
    }
    const width = Math.round(project.width);
    const height = Math.round(project.height);
    if (width < 64 || height < 64) return 'Custom size is too small.';
    if (width > 4096 || height > 4096) return 'Custom size is too large.';
    if (width % 2 !== 0 || height % 2 !== 0) return 'Custom width/height must be even.';
  }
  let totalDuration = 0;
  for (const slide of project.slides) {
    if (!slide.imageSrc && !slide.assetId) return 'Slide image is missing.';
    if (slide.imageSrc && /^data:/i.test(slide.imageSrc)) {
      return 'Slide image must be an upload or remote URL.';
    }
    if (slide.durationSec < 1 || slide.durationSec > 10) return 'Slide duration must be 1-10 seconds.';
    if (slide.overlayText && slide.overlayText.length > 120) return 'Overlay text is too long.';
    if (slide.overlayColorHex && !isValidHexColor(slide.overlayColorHex)) return 'Invalid slide text color.';
    if (slide.position === 'custom') {
      const x = slide.xPct;
      const y = slide.yPct;
      if (typeof x !== 'number' || typeof y !== 'number') return 'Custom text position requires xPct and yPct.';
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Invalid custom text position.';
      if (x < 0 || x > 1 || y < 0 || y > 1) return 'Custom text position must be within 0..1.';
    }
    totalDuration += slide.durationSec;
  }
  return null;
};

const cleanupJobs = async () => {
  const now = Date.now();
  const jobs = Array.from(jobStore.values()).sort((a, b) => a.createdAt - b.createdAt);
  const overflow = Math.max(0, jobs.length - MAX_JOBS);
  const removals = new Set<string>();

  jobs.forEach((job, index) => {
    if (job.status === 'done' || job.status === 'error') {
      if (now - job.createdAt > JOB_TTL_MS) {
        removals.add(job.id);
      }
    }
    if (index < overflow) {
      removals.add(job.id);
    }
  });

  await Promise.all(
    Array.from(removals).map(async (id) => {
      const job = jobStore.get(id);
      if (!job) return;
      jobStore.delete(id);
      if (job.workDir) {
        try {
          await fs.rm(job.workDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    })
  );
};

setInterval(cleanupJobs, CLEANUP_INTERVAL_MS).unref();
cleanupJobs();

export const createVideoJob = async (
  project: VideoProjectInput,
  userId?: string,
  baseUrl?: string
) => {
  const error = validateProject(project);
  if (error) throw new Error(error);

  const jobId = randomUUID();
  const now = Date.now();
  jobStore.set(jobId, {
    id: jobId,
    userId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    progress: 0,
  });

  const run = async () => {
    const job = jobStore.get(jobId);
    if (!job) return;
    job.status = 'running';
    job.updatedAt = Date.now();

    const tempDir = await ensureTempDir();
    job.workDir = tempDir;

    try {
      const width = project.width ?? QUALITY_MAP[project.quality].width;
      const height = project.height ?? QUALITY_MAP[project.quality].height;
      const inputPaths = await Promise.all(
        project.slides.map((slide, index) =>
          resolveImageToFile(slide.imageSrc, slide.assetId, tempDir, index, userId, baseUrl)
        )
      );

      const segmentPaths: string[] = [];
      for (let i = 0; i < project.slides.length; i += 1) {
        const slide = project.slides[i];
        const segmentPath = path.join(tempDir, `segment-${i}.mp4`);
        const filter = buildSlideFilter(slide, width, height, project.fps);
        const args = [
          '-y',
          '-loop',
          '1',
          '-t',
          slide.durationSec.toFixed(2),
          '-i',
          inputPaths[i],
          '-f',
          'lavfi',
          '-t',
          slide.durationSec.toFixed(2),
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-vf',
          filter,
          '-r',
          String(project.fps),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-shortest',
          segmentPath,
        ];
        await runFfmpeg(args);
        segmentPaths.push(segmentPath);
        job.progress = Math.round(((i + 1) / (project.slides.length + 1)) * 90);
        job.updatedAt = Date.now();
      }

      const listPath = path.join(tempDir, 'concat.txt');
      const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await fs.writeFile(listPath, listContent);

      const outputPath = path.join(tempDir, `render-${jobId}.mp4`);
      const concatArgs = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath,
      ];
      job.progress = 95;
      await runFfmpeg(concatArgs);
      job.status = 'done';
      job.outputPath = outputPath;
      job.progress = 100;
      job.updatedAt = Date.now();
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message || 'Render failed.';
      job.updatedAt = Date.now();
    }
  };

  run();
  return jobId;
};

export const getVideoJob = (id: string) => jobStore.get(id);

export const getJobOutputPath = (id: string) => jobStore.get(id)?.outputPath;

export const hasJobOutput = (id: string) => {
  const job = jobStore.get(id);
  if (!job?.outputPath) return false;
  return fsSync.existsSync(job.outputPath);
};
