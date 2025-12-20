import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

function MenuDropdown({
  open,
  onToggle,
  onClose,
  button,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  button: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

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
      <div onClick={onToggle}>{button}</div>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-20 w-[min(320px,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10 overflow-hidden">
          {children}
        </div>
      )}
    </div>
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

export function VideoCreator({ designUrl }: VideoCreatorProps) {
  const controlButtonBase =
    'inline-flex items-center gap-2 px-4 py-3 rounded-2xl border-2 bg-white transition-all text-sm text-slate-800 whitespace-nowrap hover:border-purple-300 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-200';

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

  useEffect(() => {
    if (project.slides.length === 0 && designUrl) {
      const slideSrc = isApiFileUrl(designUrl) ? toVideoFilesUrl(designUrl) : designUrl;
      const slide = createSlide(withUid(slideSrc), 'Design Preview', undefined, motionMode);
      setProject((prev) => ({ ...prev, slides: [slide] }));
      setSelectedSlideId(slide.id);
    }
  }, [designUrl, motionMode, project.slides.length]);

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
        const objectUrl = URL.createObjectURL(blob);
        if (renderState.videoUrl) {
          URL.revokeObjectURL(renderState.videoUrl);
        }
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

  const currentSlideIndex = project.slides.findIndex((slide) => slide.id === selectedSlideId);
  const currentSlide = project.slides[currentSlideIndex] || null;
  const previewImageScale =
    currentSlide?.assetId && selectedDesignId && currentSlide.assetId === selectedDesignId ? designScale : 1;

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
    const invalid = project.slides.find((slide) => !slide.assetId && /^data:/i.test(slide.imageSrc));
    if (invalid) {
      setError('Slides must be uploads or design assets (no data URLs).');
      return;
    }
    if (renderState.videoUrl) {
      URL.revokeObjectURL(renderState.videoUrl);
    }
    setRenderState({ status: 'rendering' });
    try {
      const payload: VideoProject = {
        ...project,
        slides: project.slides.map((slide) => ({
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
        setRenderState({ status: 'done', videoUrl: data.videoUrl });
        return;
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
              <span className="text-sm">
                {renderState.status === 'rendering' ? 'Rendering...' : 'Export MP4'}
              </span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => {
              setIsRightPanelOpen(true);
              setRightPanelView('myDesigns');
            }}
            aria-expanded={isRightPanelOpen}
            className={`${controlButtonBase} ${
              isRightPanelOpen && rightPanelView === 'myDesigns' ? 'border-purple-300 bg-purple-50' : 'border-slate-200'
            }`}
          >
            <FolderOpen className="w-4 h-4 text-slate-600" />
            My Designs
          </button>

          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            className={`${controlButtonBase} border-slate-200`}
          >
            <Upload className="w-4 h-4 text-slate-600" />
            Upload from PC
          </button>
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
            onToggle={() => setOpenMenu((prev) => (prev === 'slides' ? null : 'slides'))}
            onClose={() => setOpenMenu(null)}
            button={
              <button
                type="button"
                className={`${controlButtonBase} ${openMenu === 'slides' ? 'border-purple-300 bg-purple-50' : 'border-slate-200'}`}
              >
                <Layers className="w-4 h-4 text-slate-600" />
                Slides ({project.slides.length})
                <ChevronDown className="w-4 h-4 text-slate-500" />
              </button>
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
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800"
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
            onToggle={() => setOpenMenu((prev) => (prev === 'motion' ? null : 'motion'))}
            onClose={() => setOpenMenu(null)}
            button={
              <button
                type="button"
                className={`${controlButtonBase} ${openMenu === 'motion' ? 'border-purple-300 bg-purple-50' : 'border-slate-200'}`}
              >
                <Sparkles className="w-4 h-4 text-slate-600" />
                Motion: {motionMode === 'fadeIn'
                  ? 'Smooth fade'
                  : motionMode === 'slide'
                  ? 'Slide'
                  : motionMode === 'zoom'
                  ? 'Zoom'
                  : motionMode === 'rotate'
                  ? 'Rotate'
                  : 'None'}
                <ChevronDown className="w-4 h-4 text-slate-500" />
              </button>
            }
          >
            <div className="p-2">
              <p className="px-2 pt-1 pb-2 text-xs text-slate-500">Slide motion</p>
              <div className="space-y-1">
                {[
                  { id: 'fadeIn' as const, label: 'Smooth fade', helper: 'Gentle cross-fade between slides.' },
                  { id: 'slide' as const, label: 'Slide', helper: 'Slides move in (left-to-right).' },
                  { id: 'zoom' as const, label: 'Zoom', helper: 'Subtle zoom-in on each slide.' },
                  { id: 'rotate' as const, label: 'Rotate', helper: 'Small rotation + settle.' },
                  { id: 'none' as const, label: 'None', helper: 'Hard cut (no motion).' },
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
                          ? 'w-full flex items-start justify-between gap-3 px-3 py-2 rounded-xl border border-purple-300 bg-purple-50 text-left'
                          : 'w-full flex items-start justify-between gap-3 px-3 py-2 rounded-xl border border-transparent hover:bg-slate-50 text-left'
                      }
                    >
                      <span className="min-w-0">
                        <span className="block text-sm text-slate-900">{opt.label}</span>
                        <span className="block text-xs text-slate-500 line-clamp-1">{opt.helper}</span>
                      </span>
                      {active && <Check className="w-4 h-4 text-purple-600 flex-none mt-0.5" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </MenuDropdown>

          <MenuDropdown
            open={openMenu === 'export'}
            onToggle={() => setOpenMenu((prev) => (prev === 'export' ? null : 'export'))}
            onClose={() => setOpenMenu(null)}
            button={
              <button
                type="button"
                className={`${controlButtonBase} ${openMenu === 'export' ? 'border-purple-300 bg-purple-50' : 'border-slate-200'}`}
              >
                <SlidersHorizontal className="w-4 h-4 text-slate-600" />
                Export: {qualityLabel(project.quality)} · {formatLabel(project.format)} · {project.fps} fps
                <ChevronDown className="w-4 h-4 text-slate-500" />
              </button>
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
                          ? 'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900'
                          : 'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800'
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
                          ? 'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900'
                          : 'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-transparent hover:bg-slate-50 text-left text-sm text-slate-800'
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
                          ? 'px-3 py-2 rounded-xl border border-purple-300 bg-purple-50 text-left text-sm text-slate-900'
                          : 'px-3 py-2 rounded-xl border border-slate-200 bg-white hover:border-purple-300 text-left text-sm text-slate-800'
                      }
                    >
                      {fps} fps
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 text-sm text-slate-600 space-y-2">
                <div className="flex items-center justify-between">
                  <span>Total Duration</span>
                  <span className="text-slate-900">{totalDuration.toFixed(1)}s</span>
                </div>
              </div>
            </div>
          </MenuDropdown>
        </div>

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

	        <div className="rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden">
	          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
	            <div className="flex items-center gap-2 text-sm text-slate-700">
	              <Video className="h-5 w-5 text-slate-600" />
	              Preview
	            </div>
	            <span className="text-xs text-slate-500">
	              Slide {currentSlideIndex + 1 || 0} of {project.slides.length}
	            </span>
	          </div>

	          <div className="relative">
	            <div className="p-6">
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
	            </div>
	          </div>
	        </div>
	      </div>

      <RightSidePanel
        open={isRightPanelOpen}
        title={rightPanelView === 'myDesigns' ? 'My Designs' : 'Text Editor'}
        subtitle={
          rightPanelView === 'myDesigns'
            ? 'Select a saved design to apply to the canvas.'
            : 'Edit the text overlay on the selected slide.'
        }
        onClose={closePanel}
      >
        {rightPanelView === 'myDesigns' ? (
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
                    addSlides(items.map((item) => ({ url: item.url, label: item.label, assetId: item.url })));
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
        )}
      </RightSidePanel>
    </div>
  );
}
