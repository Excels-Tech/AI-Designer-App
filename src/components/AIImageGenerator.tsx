import { useMemo, useRef, useState, useEffect, useLayoutEffect, type ReactNode } from 'react';
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
import { authFetch, getUserId } from '../utils/auth';
import { TOOLBAR_ICON_BTN, TOOLBAR_PILL_BTN } from './ui/toolbarStyles';

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
  normalized.add('back');
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function computePreviewScaleFromImageSrc(
  src: string,
  {
    targetFillRatio = 0.85,
    nearWhiteThreshold = 250,
    maxScale = 1.8,
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
    const ctx = canvas.getContext('2d');
    if (!ctx) return 1;

    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;

    let top = height;
    let bottom = -1;

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
      }
    }

    if (bottom < top) return 1;

    const bboxHeight = bottom - top + 1;
    const fillRatio = bboxHeight / height;
    if (!Number.isFinite(fillRatio) || fillRatio <= 0) return 1;

    const scale = clamp(targetFillRatio / fillRatio, 1, maxScale);
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
  style?: React.CSSProperties;
}) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setScale(1);
    void (async () => {
      const next = await computePreviewScaleFromImageSrc(src);
      if (!cancelled) setScale(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={{
        transform: scale > 1 ? `scale(${scale})` : undefined,
        transformOrigin: 'center',
        ...style,
      }}
    />
  );
}

function isProbablyValidPngDataUrl(src: string) {
  const trimmed = String(src || '').trim();
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
  return Boolean(match?.[1] && match[1].length > 1000);
}

function trimCanvasToContent(
  canvas: HTMLCanvasElement,
  {
    treatNearWhiteAsEmpty = true,
    nearWhiteThreshold = 245,
  }: { treatNearWhiteAsEmpty?: boolean; nearWhiteThreshold?: number } = {}
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
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

  const tctx = trimmed.getContext('2d');
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
  const ctx = canvas.getContext('2d');
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
  const ctx = canvas.getContext('2d');
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
  const outCtx = out.getContext('2d');
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

  const ctx = canvas.getContext('2d');
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

    const ctx = canvas.getContext('2d');
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
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported.');

      // Force a white background so previews/downloads never show gray/transparent backgrounds.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, width, height);

      // Normalize light neutral backgrounds to pure white.
      normalizeCanvasBackgroundToWhite(canvas);

      // Crop tightly so the object fills the frame consistently across views.
      // (Helps tiny back views by removing excess background.)
      let croppedCanvas = cropCanvasToContent(canvas, { targetFillRatio: 0.85, paddingPercent: 0.1 });

      // If cropping got too aggressive (common with white garments), fall back to a safer trim pass.
      const croppedArea = croppedCanvas.width * croppedCanvas.height;
      const fullArea = canvas.width * canvas.height;
      if (croppedArea > 0 && fullArea > 0 && croppedArea / fullArea < 0.15) {
        croppedCanvas = trimCanvasToContent(canvas, { treatNearWhiteAsEmpty: false });
      }

      // Ensure final export is solid white background PNG.
      const out = document.createElement('canvas');
      out.width = croppedCanvas.width;
      out.height = croppedCanvas.height;
      const outCtx = out.getContext('2d');
      if (!outCtx) throw new Error('Canvas not supported.');
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, out.width, out.height);
      outCtx.drawImage(croppedCanvas, 0, 0);

      return out.toDataURL('image/png');
    } finally {
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    }
  };

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
      const ctx = canvas.getContext('2d');
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
  const [selectedViews, setSelectedViews] = useState<ViewKey[]>(['front', 'back']);
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

  useEffect(() => {
    setUserId(getUserId());
  }, []);

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
          prompt: trimmedPrompt,
          style: effectiveStyle,
          resolution,
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
          prompt: trimmedPrompt,
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
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64 };
      });

      const composite = `data:image/png;base64,${String(viewsPayload.compositeBase64)}`;
      const baseVariant: GeneratedVariant = {
        id: crypto.randomUUID(),
        kind: 'base',
        styleLabel: styleOptions.find((opt) => opt.id === effectiveStyle)?.label ?? String(effectiveStyle),
        styleKey: effectiveStyle,
        views: normalizedViews,
        composite,
        images: orderedImages,
      };

      setVariants([baseVariant]);
      setHasResultFlag(true);
      setStatusMessage('Generated views successfully.');
      onGenerate?.(composite);
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
          `Converting style to ${styleOptions.find((opt) => opt.id === target)?.label ?? target} (${i + 1}/${
            base.views.length
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
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64 };
      });

      const composite = await composeCompositeFromTiles(orderedImages, resolution);
      const styleVariant: GeneratedVariant = {
        id: crypto.randomUUID(),
        kind: 'style_converted',
        styleLabel: styleOptions.find((opt) => opt.id === target)?.label ?? String(target),
        styleKey: target,
        views: base.views,
        composite,
        images: orderedImages,
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
        return { view, src: `data:image/png;base64,${imageBase64}`, imageBase64 };
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
        images: orderedImages,
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
    const stripPngDataUrl = (dataUrl: string) => {
      const match = /^data:image\/png;base64,(.+)$/i.exec(String(dataUrl || '').trim());
      return match?.[1] ?? '';
    };

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
    setStatusMessage('Preparing ZIP export...');
    setError(null);

    try {
      const resp = await authFetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'zip', items }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || 'Export failed.');
      if (!payload?.url) throw new Error('Export failed.');
      window.location.href = String(payload.url);
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
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
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
                    <p className="mt-2 text-[12px] text-slate-500">All views will use this style</p>
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

	            </div>

            <p className="text-xs text-slate-500">
              Generates a front base design first, then generates the selected views from that base for consistent designs.
            </p>
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

          <button
            onClick={handleGenerate}
            disabled={isGenerating || prompt.trim().length === 0}
            className="w-full bg-gradient-to-r from-violet-500 to-purple-500 text-white py-4 rounded-2xl hover:shadow-2xl hover:shadow-purple-500/40 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Generating...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                <span>Generate Image</span>
              </>
            )}
          </button>

          {statusMessage && !isGenerating && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-2 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              {statusMessage}
            </p>
          )}
        </div>

	        {hasAnyResult && (
	          <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
	            <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
	              <div className="flex items-center justify-between">
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

                <button
                  onClick={() => {
                    if (hasEditedViews) {
                      if (!editedViews?.length) return;
                      editedViews.forEach((item) => {
                        if (!item.imageDataUrl) return;
                        const link = document.createElement('a');
                        link.href = item.imageDataUrl;
                        const styleSuffix = item.style ? `-${String(item.style).trim()}` : '';
                        link.download = `${item.view}${styleSuffix}.png`;
                        link.click();
                      });
                      return;
                    }

                    if (editedPrimaryImage) {
                      const link = document.createElement('a');
                      link.href = editedPrimaryImage;
                      link.download = 'edited.png';
                      link.click();
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
	
	              <div className="mt-4 grid grid-cols-2 gap-4 w-full">
	                {hasEditedViews || hasSingleEditResult ? (
	                  editedPrimaryImage ? (
	                    <div className="col-span-2 w-full h-[320px] rounded-xl overflow-hidden bg-white border border-slate-200 flex items-center justify-center">
	                      <AutoScaledPreviewImage src={editedPrimaryImage} alt="Preview" className="w-full h-full object-contain bg-white" />
	                    </div>
	                  ) : null
	                ) : variants.length > 1 ? (
	                  <div className="col-span-2 space-y-4">
	                    {variants.map((variant) => (
	                      <div key={variant.id} className="rounded-2xl border border-slate-200 bg-white p-4">
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
	                        <div className="mt-3 grid grid-cols-2 gap-4">
	                          {variant.images.map((image) => (
	                            <div
	                              key={`${variant.id}-${image.view}`}
	                              className="w-full h-[260px] rounded-xl overflow-hidden bg-white border border-slate-200 flex items-center justify-center"
	                            >
	                              {isProbablyValidPngDataUrl(image.src) ? (
	                                <AutoScaledPreviewImage
	                                  src={image.src}
	                                  alt={viewLabel(image.view)}
	                                  className="w-full h-full object-contain bg-white"
	                                />
	                              ) : (
	                                <div className="p-4 text-center">
	                                  <p className="text-sm text-slate-900">Invalid image</p>
	                                  <p className="text-xs text-slate-500 mt-1">This view failed to render.</p>
	                                  {variant.kind === 'style_converted' && variant.styleKey && (
	                                    <button
	                                      type="button"
	                                      className="mt-3 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-purple-600 text-white text-xs hover:bg-purple-700"
	                                      onClick={() => handleConvertStyle(variant.styleKey as ArtStyleKey)}
	                                    >
	                                      Retry conversion
	                                    </button>
	                                  )}
	                                </div>
	                              )}
	                            </div>
	                          ))}
	                        </div>
	                      </div>
	                    ))}
	                  </div>
	                ) : (
	                  ((variants[0]?.images ?? result?.images) ?? []).map((image) => (
	                    <div
	                      key={image.view}
	                      className="w-full h-[260px] rounded-xl overflow-hidden bg-white border border-slate-200 flex items-center justify-center"
	                    >
	                      {isProbablyValidPngDataUrl(image.src) ? (
	                        <AutoScaledPreviewImage
	                          src={image.src}
	                          alt={viewLabel(image.view)}
	                          className="w-full h-full object-contain bg-white"
	                        />
	                      ) : (
	                        <div className="p-4 text-center">
	                          <p className="text-sm text-slate-900">Invalid image</p>
	                          <p className="text-xs text-slate-500 mt-1">This view failed to render.</p>
	                        </div>
	                      )}
	                    </div>
	                  ))
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
                      <div className="bg-white p-2">
                        {item.imageDataUrl ? (
                          <img
                            src={item.imageDataUrl}
                            alt={viewLabel(item.view)}
                            className="w-full h-auto object-contain bg-white rounded-xl shadow-md scale-[1.05]"
                          />
                        ) : (
                          <div className="p-4 text-center">
                            <p className="text-sm text-slate-900">{viewLabel(item.view)}</p>
                            <p className="text-xs text-red-600 mt-1">{item.error || 'Failed'}</p>
                          </div>
                        )}
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
                              const link = document.createElement('a');
                              link.href = item.imageDataUrl as string;
                              const styleSuffix = item.style ? `-${String(item.style).trim()}` : '';
                              link.download = `${item.view}${styleSuffix}.png`;
                              link.click();
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

            {(variants.length > 0 || result) && (
            <div>
              <p className="text-slate-900 font-medium mb-3">Cropped Views</p>
              {variants.length > 0 ? (
                <div className="space-y-6">
                  {variants.map((variant) => (
                    <div key={variant.id}>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {variant.modelLabel && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
                            Model: {variant.modelLabel}
                          </span>
                        )}
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700">
                          Style: {variant.styleLabel}
                        </span>
                      </div>
                      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
                        {variant.images.map((image) => {
                          const suffix = [variant.modelLabel, variant.styleLabel].filter(Boolean).join('-').replace(/\s+/g, '_');
                          return (
                            <div
                              key={`${variant.id}-${image.view}`}
                              className="rounded-2xl border border-slate-200 overflow-hidden bg-white shadow-sm"
                            >
                      <div className="w-full h-[260px] flex items-center justify-center bg-white overflow-hidden">
                                {isProbablyValidPngDataUrl(image.src) ? (
                                  <AutoScaledPreviewImage
                                    src={image.src}
                                    alt={viewLabel(image.view)}
                                    className="w-full h-full object-contain bg-white"
                                  />
                                ) : (
                                  <div className="p-4 text-center">
                                    <p className="text-sm text-slate-900">Invalid image</p>
                                    <p className="text-xs text-slate-500 mt-1">This view failed to render.</p>
                                    {variant.kind === 'style_converted' && variant.styleKey && (
                                      <button
                                        type="button"
                                        className="mt-3 inline-flex items-center justify-center px-3 py-2 rounded-lg bg-purple-600 text-white text-xs hover:bg-purple-700"
                                        onClick={() => handleConvertStyle(variant.styleKey as ArtStyleKey)}
                                      >
                                        Retry conversion
                                      </button>
                                    )}
                                  </div>
                                )}
                      </div>
                              <div className="p-3 flex items-center justify-between">
                                <div>
                                  <p className="text-sm text-slate-900">{viewLabel(image.view)}</p>
                                  <p className="text-xs text-slate-500">Generated view</p>
                                </div>
                                <button
                                  onClick={() => {
                                    const link = document.createElement('a');
                                    link.href = image.src;
                                    link.download = suffix ? `${image.view}-${suffix}.png` : `${image.view}.png`;
                                    link.click();
                                  }}
                                  className="text-purple-600 text-xs hover:underline"
                                >
                                  Download
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : result ? (
                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {result.images.map((image) => (
                    <div
                      key={image.view}
                      className="rounded-2xl border border-slate-200 overflow-hidden bg-white shadow-sm"
                    >
                      <div className="w-full h-[260px] flex items-center justify-center bg-white overflow-hidden">
                        {isProbablyValidPngDataUrl(image.src) ? (
                          <AutoScaledPreviewImage
                            src={image.src}
                            alt={viewLabel(image.view)}
                            className="w-full h-full object-contain bg-white"
                          />
                        ) : (
                          <div className="p-4 text-center">
                            <p className="text-sm text-slate-900">Invalid image</p>
                            <p className="text-xs text-slate-500 mt-1">This view failed to render.</p>
                          </div>
                        )}
                      </div>
                      <div className="p-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm text-slate-900">{viewLabel(image.view)}</p>
                          <p className="text-xs text-slate-500">Generated view</p>
                        </div>
                        <button
                          onClick={() => {
                            const link = document.createElement('a');
                            link.href = image.src;
                            link.download = `${image.view}.png`;
                            link.click();
                          }}
                          className="text-purple-600 text-xs hover:underline"
                        >
                          Download
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
