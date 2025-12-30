import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  Film,
  FolderOpen,
  Layers,
  Sparkles,
  Plus,
  SlidersHorizontal,
  Upload,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import { authFetch, getUserId, resolveApiAssetUrl } from '../utils/auth';
import { PreviewPlayer } from './video-creator/PreviewPlayer';
import { SlideEditor } from './video-creator/SlideEditor';
import { SlideList } from './video-creator/SlideList';
import type { Slide, SlideAnimation, VideoProject } from './video-creator/types';
import { RightDrawerMyDesigns } from './video-creator/RightDrawerMyDesigns';
import type { DesignCardItem } from './video-creator/DesignsGrid';
import { RightSidePanel } from './video-creator/RightSidePanel';
import { AssetPicker } from './video-creator/AssetPicker';
import { TOOLBAR_PILL_BTN } from './ui/toolbarStyles';

interface VideoCreatorProps {
  designUrl: string | null;
}

const MAX_SLIDES = 20;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const FPS_OPTIONS = [12, 24, 30, 60] as const;
const isApiFileUrl = (src: string) => src.startsWith('/api/files/');
const ACCEPTED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const qualityLabel = (quality: VideoProject['quality']) => (quality === '720p' ? '720p HD' : '1080p Full HD');
const formatLabel = (format: VideoProject['format']) => (format === 'mp4' ? 'MP4' : format);

type ImageDimensions = { width: number; height: number };

async function getVideoDurationSec(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    const cleanup = () => {
      URL.revokeObjectURL(url);
    };
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve(duration);
    };
    video.onerror = () => {
      cleanup();
      resolve(0);
    };
  });
}

async function getVideoDurationSecFromUrl(url: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      resolve(duration);
    };
    video.onerror = () => resolve(0);
  });
}

async function getRemoteVideoSizeBytes(url: string): Promise<number | null> {
  if (/^(blob:|data:)/i.test(url)) return null;
  try {
    const head = await authFetch(url, { method: 'HEAD' });
    if (head.ok) {
      const len = Number(head.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0) return len;
    }
  } catch {
    // ignore
  }
  try {
    const range = await authFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    if (!range.ok) return null;
    const contentRange = range.headers.get('content-range');
    if (!contentRange) return null;
    const match = /\/(\d+)\s*$/i.exec(contentRange);
    if (!match) return null;
    const total = Number(match[1]);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

function normalizeEvenDimension(value: number) {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return 0;
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

async function loadImageNaturalDimensions(src: string): Promise<ImageDimensions | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;

    const finish = (value: ImageDimensions | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    img.onload = () => {
      const width = normalizeEvenDimension(img.naturalWidth);
      const height = normalizeEvenDimension(img.naturalHeight);
      if (width > 0 && height > 0) {
        finish({ width, height });
      } else {
        finish(null);
      }
    };

    img.onerror = () => finish(null);
    img.src = src;
  });
}

async function getAllImageDimensions(slides: Slide[]): Promise<ImageDimensions[]> {
  const results = await Promise.allSettled(
    slides.map(async (slide) => {
      const src = withUid(slide.imageSrc);
      return loadImageNaturalDimensions(src);
    })
  );

  return results
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter((value): value is ImageDimensions => Boolean(value));
}

function pickMostCommonDimensions(dimensions: ImageDimensions[]): ImageDimensions | null {
  if (!dimensions.length) return null;
  const counts = new Map<string, { width: number; height: number; count: number }>();
  for (const dim of dimensions) {
    const key = `${dim.width}x${dim.height}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { ...dim, count: 1 });
  }
  const best = Array.from(counts.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    return areaA - areaB;
  })[0];
  return best ? { width: best.width, height: best.height } : null;
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

function VideoToolbarButton({
  icon: Icon,
  label,
  isOpen,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  isOpen?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={typeof isOpen === 'boolean' ? isOpen : undefined}
      className={`${className ?? ''} ${TOOLBAR_PILL_BTN} ${isOpen ? 'border-purple-300 bg-purple-50' : ''}`}
    >
      <span className="flex items-center w-full justify-between gap-3 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <Icon className="w-5 h-5 text-slate-600 shrink-0 block" />
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown className="w-5 h-5 text-slate-500 shrink-0 block" />
      </span>
    </button>
  );
}

const withUid = (url: string) => {
  const resolved = resolveApiAssetUrl(url);
  if (/[?&]uid=/i.test(resolved)) return resolved;
  try {
    const parsed = new URL(resolved, window.location.origin);
    if (!parsed.pathname.startsWith('/api/')) return resolved;
    parsed.searchParams.set('uid', getUserId());
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    if (!resolved.startsWith('/api/')) return resolved;
    const sep = resolved.includes('?') ? '&' : '?';
    return `${resolved}${sep}uid=${encodeURIComponent(getUserId())}`;
  }
};

const toVideoFilesUrl = (url: string) => {
  if (!isApiFileUrl(url)) return url;
  return `/api/video/files/${url.slice('/api/files/'.length)}`;
};

const createSlide = (imageSrc: string, label?: string, assetId?: string, animation: SlideAnimation = 'fadeIn'): Slide => ({
  id: crypto.randomUUID(),
  imageSrc,
  assetId,
  durationSec: 3,
  overlayText: label || '',
  overlayColorHex: '#FFFFFF',
  fontStyle: 'modern',
  fontSizePx: 48,
  position: 'bottom',
  animation,
});

const normalizeDurations = (slides: Slide[]) => {
  if (!slides.length) return slides;
  const per = Math.min(10, Math.max(1, 10 / slides.length));
  return slides.map((slide) => ({ ...slide, durationSec: per }));
};

const isUploadableLocalUrl = (src: string) => /^(data:|blob:)/i.test(src.trim());

async function localUrlToFile(src: string, fileBaseName: string): Promise<File> {
  const res = await fetch(src);
  const blob = await res.blob();
  const type = blob.type || 'image/png';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `${fileBaseName}.${ext}`, { type });
}

export function VideoCreator({ designUrl: _designUrl }: VideoCreatorProps) {
  const [project, setProject] = useState<VideoProject>({
    id: crypto.randomUUID(),
    quality: '1080p',
    format: 'mp4',
    fps: 30,
    slides: [],
  });
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<'slides' | 'export' | 'motion' | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [motionMode, setMotionMode] = useState<SlideAnimation>('fadeIn');

  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [rightPanelView, setRightPanelView] = useState<'myDesigns' | 'textEditor'>('myDesigns');
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null);
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [designScale, setDesignScale] = useState(1);
  const [exportCanvasDimensions, setExportCanvasDimensions] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [exportedSizeMB, setExportedSizeMB] = useState<string | null>(null);
  const [exportedDurationSec, setExportedDurationSec] = useState<number | null>(null);
  const [renderState, setRenderState] = useState<{
    status: 'idle' | 'rendering' | 'done' | 'error';
    jobId?: string;
    videoUrl?: string | null;
    progress?: number;
    error?: string | null;
  }>({ status: 'idle' });
  const [videoTitle, setVideoTitle] = useState('');
  const [videoSaveState, setVideoSaveState] = useState<{
    status: 'idle' | 'saving' | 'saved' | 'error';
    id?: string;
    message?: string;
    error?: string;
  }>({ status: 'idle' });

  const resetRenderedPreview = () => {
    setVideoSaveState((prev) => (prev.status === 'idle' ? prev : { status: 'idle' }));
    setExportedSizeMB(null);
    setExportedDurationSec(null);
    setRenderState((prev) => {
      if (prev.status === 'idle' && !prev.videoUrl && !prev.jobId && !prev.progress && !prev.error) return prev;
      if (prev.videoUrl) {
        URL.revokeObjectURL(prev.videoUrl);
      }
      return { status: 'idle' };
    });
  };

  const totalDuration = useMemo(
    () => project.slides.reduce((acc, slide) => acc + slide.durationSec, 0),
    [project.slides]
  );

  // Preview starts empty. Slides appear only after the user uploads images or selects a design.

  useEffect(() => {
    if (project.slides.length === 0) {
      setSelectedSlideId(null);
      setCurrentTime(0);
      return;
    }
    if (!selectedSlideId) {
      setSelectedSlideId(project.slides[0]?.id ?? null);
    }
  }, [project.slides, selectedSlideId]);

  useEffect(() => {
    if (totalDuration === 0) {
      setCurrentTime(0);
      setIsPlaying(false);
      return;
    }
    if (currentTime > totalDuration) {
      setCurrentTime(totalDuration);
      setIsPlaying(false);
    }
  }, [currentTime, totalDuration]);

  useEffect(() => {
    return () => {
      if (renderState.videoUrl) {
        URL.revokeObjectURL(renderState.videoUrl);
      }
    };
  }, [renderState.videoUrl]);

  useEffect(() => {
    if (!isRightPanelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsRightPanelOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isRightPanelOpen]);

  useEffect(() => {
    if (renderState.status !== 'rendering' || !renderState.jobId) return;
    const interval = window.setInterval(async () => {
      const res = await authFetch(`/api/video/status/${renderState.jobId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'done') {
        window.clearInterval(interval);
        const videoRes = await authFetch(`/api/video/download/${renderState.jobId}`);
        if (!videoRes.ok) {
          setRenderState({ status: 'error', error: 'Failed to fetch rendered video.' });
          return;
        }
        const blob = await videoRes.blob();
        const nextSizeMB = (blob.size / (1024 * 1024)).toFixed(2);
        const nextDurationSec = await getVideoDurationSec(blob);
        const objectUrl = URL.createObjectURL(blob);
        if (renderState.videoUrl) {
          URL.revokeObjectURL(renderState.videoUrl);
        }
        setExportedSizeMB(nextSizeMB);
        setExportedDurationSec(nextDurationSec);
        setRenderState({ status: 'done', jobId: renderState.jobId, videoUrl: objectUrl, progress: 100 });
      } else if (data.status === 'error') {
        window.clearInterval(interval);
        setRenderState({ status: 'error', error: data.error || 'Render failed.' });
      } else if (typeof data.progress === 'number') {
        setRenderState((prev) => ({ ...prev, progress: data.progress }));
      }
    }, 1500);
    return () => window.clearInterval(interval);
  }, [renderState]);

  useEffect(() => {
    if (renderState.status !== 'done' || !renderState.videoUrl) return;
    let cancelled = false;
    const videoUrl = renderState.videoUrl;

    if (exportedDurationSec === null) {
      void getVideoDurationSecFromUrl(videoUrl).then((duration) => {
        if (cancelled) return;
        setExportedDurationSec(duration);
      });
    }

    if (exportedSizeMB === null) {
      void getRemoteVideoSizeBytes(videoUrl).then((bytes) => {
        if (cancelled) return;
        if (!bytes) return;
        setExportedSizeMB((bytes / (1024 * 1024)).toFixed(2));
      });
    }

    return () => {
      cancelled = true;
    };
  }, [exportedDurationSec, exportedSizeMB, renderState.status, renderState.videoUrl]);

  const slideImageKey = useMemo(() => project.slides.map((slide) => slide.imageSrc).join('|'), [project.slides]);
  useEffect(() => {
    if (!project.slides.length) {
      setExportCanvasDimensions({ width: 0, height: 0 });
      return;
    }
    let cancelled = false;
    void (async () => {
      const dims = await getAllImageDimensions(project.slides);
      const picked = pickMostCommonDimensions(dims);
      if (!picked) return;
      if (cancelled) return;
      setExportCanvasDimensions(picked);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.slides.length, slideImageKey]);

  const currentSlideIndex = project.slides.findIndex((slide) => slide.id === selectedSlideId);
  const currentSlide = project.slides[currentSlideIndex] || null;
  const previewImageScale =
    currentSlide?.assetId && selectedDesignId && currentSlide.assetId === selectedDesignId ? designScale : 1;
  const hasPreviewContent = project.slides.length > 0;
  const maxPreviewWidthPx = 900;
  const previewMaxHeight = 'calc(100vh - 260px)';
  const previewFrameStyle = useMemo(() => {
    const base: CSSProperties = {
      width: `min(100%, ${maxPreviewWidthPx}px)`,
      maxHeight: previewMaxHeight,
    };
    if (exportCanvasDimensions.width > 0 && exportCanvasDimensions.height > 0) {
      base.aspectRatio = `${exportCanvasDimensions.width} / ${exportCanvasDimensions.height}`;
    }
    return base;
  }, [exportCanvasDimensions.height, exportCanvasDimensions.width]);

  const handleSlideSelect = (id: string) => {
    setSelectedSlideId(id);
    const index = project.slides.findIndex((slide) => slide.id === id);
    if (index >= 0) {
      const time = project.slides.slice(0, index).reduce((acc, slide) => acc + slide.durationSec, 0);
      setCurrentTime(time);
    }
  };

  const handleSelectDesign = (item: DesignCardItem) => {
    resetRenderedPreview();
    setIsRightPanelOpen(true);
    setRightPanelView('textEditor');
    setSelectedDesignId(item.id);
    setIsAssetPickerOpen(false);
    setDesignScale(1);

    const slide = createSlide(withUid(item.thumbnail), item.title, item.id, motionMode);
    setProject((prev) => ({ ...prev, slides: normalizeDurations([slide, ...prev.slides]).slice(0, MAX_SLIDES) }));
    setSelectedSlideId(slide.id);
    setCurrentTime(0);
    setIsPlaying(false);
  };

  const closePanel = () => {
    setIsRightPanelOpen(false);
    setIsAssetPickerOpen(false);
  };

  const addSlides = (items: { url: string; label?: string; assetId?: string }[]) => {
    setError(null);
    resetRenderedPreview();
    const existing = new Set(project.slides.map((slide) => slide.assetId ?? slide.imageSrc));
    const seen = new Set<string>();
    const filtered = items
      .map((item) => ({ ...item, url: withUid(item.url) }))
      .filter((item) => {
        const key = item.assetId ?? item.url;
        if (existing.has(key) || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    if (project.slides.length + filtered.length > MAX_SLIDES) {
      setError(`Limit is ${MAX_SLIDES} slides per project.`);
      return;
    }
    const newSlides = filtered.map((item) => createSlide(item.url, item.label, item.assetId, motionMode));
    const nextSlides = normalizeDurations([...project.slides, ...newSlides]);
    setProject((prev) => ({ ...prev, slides: nextSlides }));
    if (!selectedSlideId && newSlides[0]) {
      setSelectedSlideId(newSlides[0].id);
    }
  };

  const handleUpload = async (files: File[]) => {
    setError(null);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      const res = await authFetch('/api/video/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Upload failed.');
      }
      const data = await res.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      addSlides(
        assets.map((asset: any, index: number) => ({
          url: withUid(asset.url),
          assetId: asset.assetId,
          label: files[index]?.name || 'Upload',
        }))
      );
    } catch (err: any) {
      setError(err?.message || 'Failed to load files.');
    }
  };

  const handleUploadFromPc = (fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList);
    const remaining = Math.max(0, MAX_SLIDES - project.slides.length);

    if (!files.length) return;
    if (remaining === 0) {
      setError('No more slides can be added.');
      return;
    }
    if (files.length > remaining) {
      setError(`Limit is ${remaining} images right now.`);
      return;
    }

    const invalidType = files.find((file) => !ACCEPTED_UPLOAD_TYPES.includes(file.type));
    if (invalidType) {
      setError('Only PNG, JPG, and WEBP images are supported.');
      return;
    }

    const oversized = files.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      setError(`Max file size is ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB.`);
      return;
    }

    void handleUpload(files);
  };

  const updateSlide = (updates: Partial<Slide>) => {
    if (!selectedSlideId) return;
    resetRenderedPreview();
    setProject((prev) => ({
      ...prev,
      slides: prev.slides.map((slide) => (slide.id === selectedSlideId ? { ...slide, ...updates } : slide)),
    }));
  };

  const removeSlide = (id: string) => {
    resetRenderedPreview();
    const nextSlides = normalizeDurations(project.slides.filter((slide) => slide.id !== id));
    setProject((prev) => ({ ...prev, slides: nextSlides }));
    if (selectedSlideId === id) {
      setSelectedSlideId(nextSlides[0]?.id ?? null);
      setCurrentTime(0);
    }
  };

  const renderVideo = async () => {
    setError(null);
    setVideoSaveState({ status: 'idle' });
    if (project.slides.length === 0) {
      setError('Add at least one slide to render.');
      return;
    }
    if (renderState.videoUrl) {
      URL.revokeObjectURL(renderState.videoUrl);
    }
    setExportedSizeMB(null);
    setExportedDurationSec(null);
    setRenderState({ status: 'rendering' });
    try {
      let slidesForRender = project.slides;

      // If any slides are local-only URLs (data/blob), upload them to /api/video/upload so the server renderer can fetch them.
      const localSlides = slidesForRender.filter((slide) => !slide.assetId && isUploadableLocalUrl(slide.imageSrc));
      if (localSlides.length) {
        const files = await Promise.all(
          localSlides.map((slide, index) => localUrlToFile(slide.imageSrc, `slide-${slide.id}-${index}`))
        );
        const formData = new FormData();
        files.forEach((file) => formData.append('files', file));
        const uploadRes = await authFetch('/api/video/upload', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok) {
          throw new Error(uploadData.error || 'Upload failed.');
        }
        const assets = Array.isArray(uploadData.assets) ? uploadData.assets : [];
        if (assets.length !== localSlides.length) {
          throw new Error('Upload failed.');
        }

        const slideIdToAsset = new Map<string, { assetId: string; url: string }>();
        localSlides.forEach((slide, index) => {
          const asset = assets[index];
          if (!asset?.assetId || !asset?.url) return;
          slideIdToAsset.set(slide.id, { assetId: String(asset.assetId), url: String(asset.url) });
        });

        const nextSlides = slidesForRender.map((slide) => {
          const asset = slideIdToAsset.get(slide.id);
          if (!asset) return slide;
          return { ...slide, assetId: asset.assetId, imageSrc: withUid(asset.url) };
        });

        slidesForRender = nextSlides;
        setProject((prev) => ({ ...prev, slides: nextSlides }));
      }

      const dims =
        exportCanvasDimensions.width > 0 && exportCanvasDimensions.height > 0
          ? exportCanvasDimensions
          : pickMostCommonDimensions(await getAllImageDimensions(slidesForRender));

      const payload: VideoProject = {
        ...project,
        width: dims?.width,
        height: dims?.height,
        slides: slidesForRender.map((slide) => ({
          id: slide.id,
          imageSrc: slide.imageSrc,
          assetId: slide.assetId,
          durationSec: slide.durationSec,
          overlayText: slide.overlayText,
          overlayColorHex: slide.overlayColorHex,
          fontStyle: slide.fontStyle,
          fontSizePx: slide.fontSizePx,
          position: slide.position,
          xPct: slide.xPct,
          yPct: slide.yPct,
          animation: slide.animation,
        })),
      };
      const res = await authFetch('/api/video/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Render failed.');
      }
      if (data.videoUrl) {
        try {
          const videoRes = await authFetch(data.videoUrl);
          if (!videoRes.ok) {
            setRenderState({ status: 'done', videoUrl: data.videoUrl });
            return;
          }
          const blob = await videoRes.blob();
          const nextSizeMB = (blob.size / (1024 * 1024)).toFixed(2);
          const nextDurationSec = await getVideoDurationSec(blob);
          const objectUrl = URL.createObjectURL(blob);
          setExportedSizeMB(nextSizeMB);
          setExportedDurationSec(nextDurationSec);
          setRenderState({ status: 'done', jobId: data.jobId, videoUrl: objectUrl, progress: 100 });
          return;
        } catch {
          setRenderState({ status: 'done', videoUrl: data.videoUrl });
          return;
        }
      }
      setRenderState({ status: 'rendering', jobId: data.jobId });
    } catch (err: any) {
      setRenderState({ status: 'error', error: err?.message || 'Render failed.' });
    }
  };

  const saveVideo = async () => {
    if (renderState.status !== 'done' || !renderState.jobId) return;
    const title = videoTitle.trim();
    if (!title) {
      setVideoSaveState({ status: 'error', error: 'Enter a video name before saving.' });
      return;
    }

    setVideoSaveState({ status: 'saving' });
    try {
      const res = await authFetch('/api/video-designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, jobId: renderState.jobId, project }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save video.');
      }
      setVideoSaveState({ status: 'saved', id: data.id, message: 'Saved to My Designs.' });
    } catch (err: any) {
      setVideoSaveState({ status: 'error', error: err?.message || 'Failed to save video.' });
    }
  };

  const rightPanelTitle = rightPanelView === 'myDesigns' ? 'My Designs' : 'Text Editor';
  const rightPanelSubtitle =
    rightPanelView === 'myDesigns'
      ? 'Select a saved design to apply to the canvas.'
      : 'Edit the text overlay on the selected slide.';
  const rightPanelBody: ReactNode =
    rightPanelView === 'myDesigns' ? (
      <RightDrawerMyDesigns
        open
        onClose={closePanel}
        selectedDesignId={selectedDesignId}
        onSelectDesign={handleSelectDesign}
      />
    ) : (
      <div className="h-full flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setIsAssetPickerOpen(false);
              setRightPanelView('myDesigns');
            }}
            className="text-sm text-purple-700 hover:underline"
          >
            Change design
          </button>

          <button
            type="button"
            onClick={() => setIsAssetPickerOpen(true)}
            className="text-sm text-slate-700 hover:text-slate-900"
          >
            Select cropped images
          </button>
        </div>

        <div className="px-5 py-4 border-b border-slate-200 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-800">Scale</p>
            <p className="text-xs text-slate-500">{Math.round(designScale * 100)}%</p>
          </div>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.01}
            value={designScale}
            disabled={!selectedDesignId}
            onChange={(e) => setDesignScale(Number(e.target.value))}
            className="w-full disabled:opacity-50"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {isAssetPickerOpen ? (
            <AssetPicker
              open
              variant="panel"
              appearance="embedded"
              maxSelect={Math.max(1, MAX_SLIDES - project.slides.length)}
              initialDesignId={selectedDesignId}
              onClose={() => setIsAssetPickerOpen(false)}
              onAdd={(items) => {
                addSlides(items.map((item) => ({ url: item.url, label: item.label })));
                setIsAssetPickerOpen(false);
              }}
            />
          ) : selectedDesignId ? (
            <div className="p-5 overflow-y-auto h-full">
              <SlideEditor slide={currentSlide} onUpdate={updateSlide} />
            </div>
          ) : (
            <div className="h-full text-sm text-slate-500 flex items-center justify-center text-center p-5">
              Select a design to start editing.
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div className="relative min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto space-y-6">
	        <div className="flex items-center justify-between">
	          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                <Film className="w-5 h-5 text-white" />
              </div>
              <h2 className="text-slate-900">Video Creator</h2>
            </div>
            <p className="text-slate-600">Combine multiple images into a polished MP4 with custom text overlays.</p>
          </div>
	          <div className="flex flex-col items-end gap-2">
	            <div className="flex items-center gap-3">
	              {renderState.status === 'done' && renderState.videoUrl && (
	                <a
	                  href={renderState.videoUrl}
	                  download={`video-${renderState.jobId ?? 'render'}.mp4`}
	                  className="px-4 py-2 rounded-xl bg-slate-100 text-slate-800 text-sm hover:bg-slate-200"
	                >
	                  Download MP4
	                </a>
	              )}
	              <button
	                onClick={renderVideo}
	                disabled={renderState.status === 'rendering'}
	                className="px-6 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
	              >
	                <Download className="w-4 h-4" />
	                <span className="text-sm">{renderState.status === 'rendering' ? 'Rendering...' : 'Export MP4'}</span>
	              </button>
	            </div>
	            {renderState.status === 'done' && (
	              <p className="text-sm text-slate-600">
	                {exportedSizeMB ? `File size: ${exportedSizeMB} MB` : 'File size: —'}
	                {' · '}
	                {typeof exportedDurationSec === 'number' ? `Duration: ${exportedDurationSec.toFixed(1)}s` : 'Duration: —'}
	              </p>
	            )}
	          </div>
	        </div>

        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          <VideoToolbarButton
            icon={FolderOpen}
            label="My Designs"
            isOpen={isRightPanelOpen && rightPanelView === 'myDesigns'}
            onClick={() => {
              setIsRightPanelOpen(true);
              setRightPanelView('myDesigns');
            }}
          />

          <VideoToolbarButton icon={Upload} label="Upload Image" onClick={() => uploadInputRef.current?.click()} />
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              handleUploadFromPc(event.target.files);
              event.target.value = '';
            }}
          />

          <MenuDropdown
            open={openMenu === 'slides'}
            onClose={() => setOpenMenu(null)}
            button={
              <VideoToolbarButton
                icon={Layers}
                label="Slides"
                isOpen={openMenu === 'slides'}
                onClick={() => setOpenMenu((prev) => (prev === 'slides' ? null : 'slides'))}
              />
            }
          >
            <div className="max-h-[70vh] overflow-auto">
              <div className="p-2">
                <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Quick add</p>
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => {
                      addSlides([
                        {
                          url: 'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?w=1200&h=800&fit=crop',
                          label: 'Sample',
                        },
                      ]);
                        setOpenMenu(null);
                      }}
                    className="w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800"
                  >
                    <span>Add sample slide</span>
                    <Plus className="w-4 h-4 text-slate-500 flex-none" />
                  </button>
                </div>
              </div>

              <div className="border-t border-slate-100" />

              <div className="p-2">
                <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Manage</p>
                <SlideList
                  slides={project.slides}
                  selectedId={selectedSlideId}
                  onSelect={handleSlideSelect}
                  onRemove={removeSlide}
                  onReorder={(nextSlides) => setProject((prev) => ({ ...prev, slides: nextSlides }))}
                />
              </div>
            </div>
          </MenuDropdown>

          <MenuDropdown
            open={openMenu === 'motion'}
            onClose={() => setOpenMenu(null)}
            button={
              <VideoToolbarButton
                icon={Sparkles}
                label="Slide Motion"
                isOpen={openMenu === 'motion'}
                onClick={() => setOpenMenu((prev) => (prev === 'motion' ? null : 'motion'))}
              />
            }
          >
            <div className="p-2">
              <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Slide motion</p>
              <div className="space-y-1">
                {[
                  { id: 'fadeIn' as const, label: 'Smooth fade' },
                  { id: 'slide' as const, label: 'Slide' },
                  { id: 'zoom' as const, label: 'Zoom' },
                  { id: 'rotate' as const, label: 'Rotate' },
                  { id: 'none' as const, label: 'None' },
                ].map((opt) => {
                  const active = motionMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        resetRenderedPreview();
                        setMotionMode(opt.id);
                        setProject((prev) => ({
                          ...prev,
                          slides: prev.slides.map((slide) => ({ ...slide, animation: opt.id })),
                        }));
                        setOpenMenu(null);
                      }}
                      className={
                        active
                          ? 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-purple-300 bg-purple-50 text-left'
                          : 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-transparent hover:bg-slate-50 text-left'
                      }
                    >
                      <span className="min-w-0 truncate text-sm text-slate-900">{opt.label}</span>
                      {active && <Check className="w-4 h-4 text-purple-600 flex-none shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </MenuDropdown>

          <MenuDropdown
            open={openMenu === 'export'}
            onClose={() => setOpenMenu(null)}
            button={
              <VideoToolbarButton
                icon={SlidersHorizontal}
                label="Video quality"
                isOpen={openMenu === 'export'}
                onClick={() => setOpenMenu((prev) => (prev === 'export' ? null : 'export'))}
              />
            }
          >
            <div className="p-2">
              <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Video quality</p>
              <div className="space-y-1">
                {(['720p', '1080p'] as const).map((q) => {
                  const active = project.quality === q;
                  return (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setProject((prev) => ({ ...prev, quality: q }))}
                      className={
                        active
                          ? 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900'
                          : 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800'
                      }
                    >
                      <span>{qualityLabel(q)}</span>
                      {active && <Check className="w-4 h-4 text-purple-600 flex-none" />}
                    </button>
                  );
                })}
              </div>

              <div className="my-2 border-t border-slate-100" />

              <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Format</p>
              <div className="space-y-1">
                {(['mp4'] as const).map((fmt) => {
                  const active = project.format === fmt;
                  return (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setProject((prev) => ({ ...prev, format: fmt }))}
                      className={
                        active
                          ? 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900'
                          : 'w-full h-[48px] flex items-center justify-between gap-3 px-3 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800'
                      }
                    >
                      <span>{formatLabel(fmt)}</span>
                      {active && <Check className="w-4 h-4 text-purple-600 flex-none" />}
                    </button>
                  );
                })}
              </div>

              <div className="my-2 border-t border-slate-100" />

              <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Frame rate</p>
              <div className="grid grid-cols-2 gap-2">
                {FPS_OPTIONS.map((fps) => {
                  const active = project.fps === fps;
                  return (
                    <button
                      key={fps}
                      type="button"
                      onClick={() => setProject((prev) => ({ ...prev, fps }))}
                      className={
                        active
                          ? 'h-[48px] px-3 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900 flex items-center'
                          : 'h-[48px] px-3 rounded-xl border border-slate-200 bg-white hover:border-purple-300 text-left text-sm text-slate-800 flex items-center'
                      }
                    >
                      {fps} fps
                    </button>
                  );
                })}
              </div>

	            <div className="my-2 border-t border-slate-100" />
	
	              <div className="mt-3 pt-3 border-t border-slate-100 text-sm text-slate-600 space-y-2">
	                <div className="flex items-center justify-between">
	                  <span>Total Duration</span>
                  <span className="text-slate-900">{totalDuration.toFixed(1)}s</span>
                </div>
              </div>
            </div>
          </MenuDropdown>
        </div>

        <div className="flex gap-6 items-start w-full">
          <div className="flex-1 min-w-0 space-y-6">
        {renderState.status === 'rendering' && (
          <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-sm text-slate-700">
              Rendering... {Math.round(renderState.progress ?? 0)}%
            </div>
            <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, renderState.progress ?? 0))}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {renderState.status === 'error' && renderState.error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4" />
            <span>{renderState.error}</span>
          </div>
        )}

        {renderState.status === 'done' && renderState.jobId && (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 space-y-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm text-slate-900 font-medium">Save Video to My Designs</p>
                <p className="text-xs text-slate-500">Keeps a copy so you can download later.</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <label className="block text-sm text-slate-700 mb-2">Video name</label>
                <input
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                  placeholder="e.g., Shirt promo video"
                  className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                />
              </div>
              <button
                type="button"
                onClick={saveVideo}
                disabled={videoSaveState.status === 'saving' || videoSaveState.status === 'saved' || !videoTitle.trim()}
                className={
                  videoSaveState.status === 'saving' || videoSaveState.status === 'saved' || !videoTitle.trim()
                    ? 'px-5 py-3 rounded-2xl text-sm bg-slate-200 text-slate-500 cursor-not-allowed whitespace-nowrap'
                    : 'px-5 py-3 rounded-2xl text-sm bg-gradient-to-r from-violet-500 to-purple-500 text-white hover:shadow-xl hover:shadow-purple-500/30 whitespace-nowrap'
                }
              >
                {videoSaveState.status === 'saving'
                  ? 'Saving...'
                  : videoSaveState.status === 'saved'
                  ? 'Saved'
                  : 'Save to My Designs'}
              </button>
            </div>
            {(videoSaveState.message || videoSaveState.error) && (
              <div
                className={
                  videoSaveState.message
                    ? 'rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800'
                    : 'rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'
                }
              >
                {videoSaveState.message || videoSaveState.error}
              </div>
            )}
          </div>
        )}

 	        <div className="w-full max-w-[980px] mr-auto">
 	          <div className="w-full rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden">
 	            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
 		              <div className="flex items-center gap-2 text-sm text-slate-700">
 		                <Video className="h-5 w-5 text-slate-600" />
 		                Preview
 		              </div>
		              {hasPreviewContent && (
		                <span className="text-xs text-slate-500">
		                  Slide {currentSlideIndex + 1 || 0} of {project.slides.length}
		                </span>
		              )}
 		            </div>
 		
  		            <div className="relative">
  		              <div className="px-6 py-5">
		                {hasPreviewContent ? (
		                  <PreviewPlayer
		                    slides={project.slides}
		                    onSlideUpdate={(id, updates) => {
		                      if (id !== selectedSlideId) return;
		                      updateSlide(updates);
		                    }}
		                    currentTime={currentTime}
		                    isPlaying={isPlaying}
		                    videoUrl={renderState.status === 'done' ? renderState.videoUrl : null}
		                    imageScale={previewImageScale}
		                    frameStyle={previewFrameStyle}
		                    className=""
		                    onPlayToggle={setIsPlaying}
		                    onSeek={(time) => {
		                      const clamped = Math.min(Math.max(0, time), totalDuration);
		                      setCurrentTime(clamped);
		                      if (clamped >= totalDuration) setIsPlaying(false);
		                      let acc = 0;
		                      let nextSelectedId = project.slides[project.slides.length - 1]?.id ?? null;
		                      for (let i = 0; i < project.slides.length; i += 1) {
		                        const slide = project.slides[i];
		                        acc += slide.durationSec;
		                        if (clamped < acc) {
		                          nextSelectedId = slide.id;
		                          break;
		                        }
		                      }
		                      if (nextSelectedId && nextSelectedId !== selectedSlideId) {
		                        setSelectedSlideId(nextSelectedId);
		                      }
		                    }}
		                    onSlideChange={(index) => {
		                      const slide = project.slides[index];
		                      if (slide && slide.id !== selectedSlideId) {
		                        setSelectedSlideId(slide.id);
		                      }
		                    }}
		                  />
		                ) : (
		                  <div className="flex items-center justify-center h-[420px] max-h-[calc(100vh-260px)] rounded-2xl border border-dashed border-slate-300 text-slate-400 text-sm overflow-hidden">
		                    Select a design or upload an image to preview
		                  </div>
		                )}
              </div>
            </div>
          </div>
        </div>

          </div>

          {isRightPanelOpen && (
            <aside className="hidden lg:block w-[380px] shrink-0 max-h-[calc(100vh-140px)] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="sticky top-0 bg-white flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
                <div className="min-w-0">
                  <p className="text-slate-900 font-medium truncate">{rightPanelTitle}</p>
                  <p className="text-xs text-slate-500 mt-1">{rightPanelSubtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={closePanel}
                  className="rounded-xl border border-slate-200 p-2 text-slate-700 hover:bg-slate-100"
                  aria-label="Close panel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-0">{rightPanelBody}</div>
            </aside>
          )}
        </div>
      </div>

      <div className="lg:hidden">
        <RightSidePanel open={isRightPanelOpen} title={rightPanelTitle} subtitle={rightPanelSubtitle} onClose={closePanel}>
          {rightPanelBody}
        </RightSidePanel>
      </div>
    </div>
  );
}
