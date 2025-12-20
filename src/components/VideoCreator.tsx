import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Film, Plus, Video } from 'lucide-react';
import { authFetch, getUserId, resolveApiAssetUrl } from '../utils/auth';
import { AssetPicker } from './video-creator/AssetPicker';
import { PreviewPlayer } from './video-creator/PreviewPlayer';
import { SlideEditor } from './video-creator/SlideEditor';
import { SlideList } from './video-creator/SlideList';
import { UploadDropzone } from './video-creator/UploadDropzone';
import type { Slide, VideoProject } from './video-creator/types';

interface VideoCreatorProps {
  designUrl: string | null;
}

const MAX_SLIDES = 20;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const FPS_OPTIONS = [12, 24, 30, 60] as const;
const isApiFileUrl = (src: string) => src.startsWith('/api/files/');

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

const createSlide = (imageSrc: string, label?: string, assetId?: string): Slide => ({
  id: crypto.randomUUID(),
  imageSrc,
  assetId,
  durationSec: 3,
  overlayText: label || '',
  overlayColorHex: '#FFFFFF',
  fontStyle: 'modern',
  fontSizePx: 48,
  position: 'bottom',
  animation: 'fadeIn',
});

const normalizeDurations = (slides: Slide[]) => {
  if (!slides.length) return slides;
  const per = Math.min(10, Math.max(1, 10 / slides.length));
  return slides.map((slide) => ({ ...slide, durationSec: per }));
};

export function VideoCreator({ designUrl }: VideoCreatorProps) {
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
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const totalDuration = useMemo(
    () => project.slides.reduce((acc, slide) => acc + slide.durationSec, 0),
    [project.slides]
  );

  useEffect(() => {
    if (project.slides.length === 0 && designUrl) {
      const slideSrc = isApiFileUrl(designUrl) ? toVideoFilesUrl(designUrl) : designUrl;
      const slide = createSlide(withUid(slideSrc), 'Design Preview');
      setProject((prev) => ({ ...prev, slides: [slide] }));
      setSelectedSlideId(slide.id);
    }
  }, [designUrl, project.slides.length]);

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

  const handleSlideSelect = (id: string) => {
    setSelectedSlideId(id);
    const index = project.slides.findIndex((slide) => slide.id === id);
    if (index >= 0) {
      const time = project.slides.slice(0, index).reduce((acc, slide) => acc + slide.durationSec, 0);
      setCurrentTime(time);
    }
  };

  const addSlides = (items: { url: string; label?: string; assetId?: string }[]) => {
    setError(null);
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
    const newSlides = filtered.map((item) => createSlide(item.url, item.label, item.assetId));
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

  const updateSlide = (updates: Partial<Slide>) => {
    if (!selectedSlideId) return;
    setProject((prev) => ({
      ...prev,
      slides: prev.slides.map((slide) => (slide.id === selectedSlideId ? { ...slide, ...updates } : slide)),
    }));
  };

  const removeSlide = (id: string) => {
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
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
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

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white shadow-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-slate-900">Slides ({project.slides.length})</h4>
                <button
                  type="button"
                  onClick={() => setAssetPickerOpen(true)}
                  className="rounded-xl bg-purple-500 text-white text-xs px-3 py-2 hover:bg-purple-600"
                >
                  Add from My Designs
                </button>
              </div>

              <UploadDropzone
                maxFiles={Math.max(0, MAX_SLIDES - project.slides.length)}
                maxBytes={MAX_UPLOAD_BYTES}
                onFilesAdded={handleUpload}
              />

              <SlideList
                slides={project.slides}
                selectedId={selectedSlideId}
                onSelect={handleSlideSelect}
                onRemove={removeSlide}
                onReorder={(nextSlides) => setProject((prev) => ({ ...prev, slides: nextSlides }))}
              />

              <button
                type="button"
                onClick={() =>
                  addSlides([
                    {
                      url:
                        'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?w=1200&h=800&fit=crop',
                      label: 'Sample',
                    },
                  ])
                }
                className="w-full rounded-xl border border-dashed border-slate-200 py-3 text-xs text-slate-500 hover:border-purple-400 hover:text-purple-600 flex items-center justify-center gap-2"
              >
                <Plus className="h-4 w-4" />
                Add a sample slide
              </button>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white shadow-xl p-6 space-y-4">
              <div>
                <label className="block text-sm text-slate-700 mb-2">Video Quality</label>
                <select
                  value={project.quality}
                  onChange={(event) =>
                    setProject((prev) => ({
                      ...prev,
                      quality: event.target.value === '720p' ? '720p' : '1080p',
                    }))
                  }
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                >
                  <option value="720p">720p HD</option>
                  <option value="1080p">1080p Full HD</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-700 mb-2">Format</label>
                <select
                  value={project.format}
                  onChange={() => null}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                >
                  <option value="mp4">MP4</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-700 mb-2">Frame Rate</label>
                <select
                  value={project.fps}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setProject((prev) => ({ ...prev, fps: FPS_OPTIONS.includes(next as any) ? next : 30 }));
                  }}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                >
                  {FPS_OPTIONS.map((fps) => (
                    <option key={fps} value={fps}>
                      {fps} fps
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-4 border-t border-slate-200 text-sm text-slate-600 space-y-2">
                <div className="flex items-center justify-between">
                  <span>Total Duration</span>
                  <span className="text-slate-900">{totalDuration.toFixed(1)}s</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Frame Rate</span>
                  <span className="text-slate-900">{project.fps} fps</span>
                </div>
              </div>
            </div>

          </div>

          <div className="lg:col-span-3 space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white shadow-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <Video className="h-5 w-5 text-slate-600" />
                  Preview
                </div>
                <span className="text-xs text-slate-500">
                  Slide {currentSlideIndex + 1 || 0} of {project.slides.length}
                </span>
              </div>
              <PreviewPlayer
                slides={project.slides}
                onSlideUpdate={(id, updates) => {
                  if (id !== selectedSlideId) return;
                  updateSlide(updates);
                }}
                currentTime={currentTime}
                isPlaying={isPlaying}
                videoUrl={renderState.status === 'done' ? renderState.videoUrl : null}
                onPlayToggle={setIsPlaying}
                onSeek={(time) => {
                  const clamped = Math.min(Math.max(0, time), totalDuration);
                  setCurrentTime(clamped);
                  if (clamped >= totalDuration) setIsPlaying(false);
                  let acc = 0;
                  for (let i = 0; i < project.slides.length; i += 1) {
                    acc += project.slides[i].durationSec;
                    if (clamped <= acc + 0.001) {
                      const slide = project.slides[i];
                      if (slide && slide.id !== selectedSlideId) {
                        setSelectedSlideId(slide.id);
                      }
                      break;
                    }
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

            <SlideEditor slide={currentSlide} onUpdate={updateSlide} />
          </div>
        </div>
      </div>

      <AssetPicker
        open={assetPickerOpen}
        maxSelect={MAX_SLIDES - project.slides.length}
        onClose={() => setAssetPickerOpen(false)}
        onAdd={(items) => addSlides(items.map((item) => ({ url: item.url, label: item.label })))}
      />
    </div>
  );
}
