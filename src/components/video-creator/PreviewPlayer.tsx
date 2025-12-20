import { useEffect, useMemo, useRef } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Slide } from './types';
import type { PointerEvent as ReactPointerEvent } from 'react';

type PreviewPlayerProps = {
  slides: Slide[];
  onSlideUpdate?: (id: string, updates: Partial<Slide>) => void;
  currentTime: number;
  isPlaying: boolean;
  videoUrl?: string | null;
  onPlayToggle: (next: boolean) => void;
  onSeek: (time: number) => void;
  onSlideChange: (index: number) => void;
};

const fontFamilies: Record<string, string> = {
  modern: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
  classic: '"Times New Roman", Georgia, serif',
  bold: '"Impact", "Arial Black", sans-serif',
  script: '"Segoe Script", "Comic Sans MS", cursive',
};

export function PreviewPlayer({
  slides,
  onSlideUpdate,
  currentTime,
  isPlaying,
  videoUrl,
  onPlayToggle,
  onSeek,
  onSlideChange,
}: PreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const totalDuration = useMemo(
    () => slides.reduce((acc, slide) => acc + slide.durationSec, 0),
    [slides]
  );
  const timeRef = useRef(currentTime);
  const dragRef = useRef<
    | null
    | {
        startClientX: number;
        startClientY: number;
        startXPct: number;
        startYPct: number;
      }
  >(null);

  useEffect(() => {
    timeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (!isPlaying || totalDuration === 0) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;
      const nextTime = Math.min(totalDuration, timeRef.current + delta);
      timeRef.current = nextTime;
      onSeek(nextTime);
      if (nextTime >= totalDuration) {
        onPlayToggle(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, onPlayToggle, onSeek, totalDuration]);

  const { currentSlide, currentIndex } = useMemo(() => {
    let acc = 0;
    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      acc += slide.durationSec;
      if (currentTime <= acc + 0.001) {
        return { currentSlide: slide, currentIndex: i };
      }
    }
    return { currentSlide: slides[slides.length - 1], currentIndex: Math.max(0, slides.length - 1) };
  }, [currentTime, slides]);

  useEffect(() => {
    if (slides.length === 0) return;
    onSlideChange(currentIndex);
  }, [currentIndex, onSlideChange, slides.length]);

  const progressLabel = `${currentTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s`;

  if (videoUrl) {
    return (
      <div className="space-y-4">
        <div className="aspect-video bg-slate-900 rounded-2xl overflow-hidden">
          <video src={videoUrl} controls className="h-full w-full" />
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Rendered Preview</span>
          <span>{totalDuration.toFixed(1)}s</span>
        </div>
      </div>
    );
  }

  if (!currentSlide) {
    return (
      <div className="aspect-video rounded-2xl border border-dashed border-slate-200 flex items-center justify-center text-sm text-slate-500">
        Add slides to preview your video.
      </div>
    );
  }

  const startDrag = (event: ReactPointerEvent) => {
    if (!currentSlide || !onSlideUpdate) return;
    event.preventDefault();
    event.stopPropagation();
    const startXPct = typeof currentSlide.xPct === 'number' ? currentSlide.xPct : 0.5;
    const startYPct = typeof currentSlide.yPct === 'number' ? currentSlide.yPct : 0.85;
    dragRef.current = { startClientX: event.clientX, startClientY: event.clientY, startXPct, startYPct };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: ReactPointerEvent) => {
    if (!currentSlide || !onSlideUpdate) return;
    const drag = dragRef.current;
    if (!drag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (!rect.width || !rect.height) return;
    const dxPct = (event.clientX - drag.startClientX) / rect.width;
    const dyPct = (event.clientY - drag.startClientY) / rect.height;
    const nextX = Math.min(0.95, Math.max(0.05, drag.startXPct + dxPct));
    const nextY = Math.min(0.95, Math.max(0.05, drag.startYPct + dyPct));
    onSlideUpdate(currentSlide.id, { position: 'custom', xPct: nextX, yPct: nextY });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className="space-y-4">
      <div ref={containerRef} className="relative aspect-video bg-slate-900 rounded-2xl overflow-hidden">
        <img src={currentSlide.imageSrc} alt="Preview" className="h-full w-full object-contain bg-black" />

        {currentSlide.overlayText && (
          <div
            className="absolute z-20 rounded-2xl bg-black/45 px-8 py-4 text-center text-white shadow-xl cursor-move select-none"
            style={{
              left:
                currentSlide.position === 'custom'
                  ? `${Math.round(((currentSlide.xPct ?? 0.5) * 100 + Number.EPSILON) * 100) / 100}%`
                  : '50%',
              top:
                currentSlide.position === 'custom'
                  ? `${Math.round(((currentSlide.yPct ?? 0.85) * 100 + Number.EPSILON) * 100) / 100}%`
                  : currentSlide.position === 'top'
                  ? '10%'
                  : currentSlide.position === 'center'
                  ? '50%'
                  : '85%',
              transform: 'translate(-50%, -50%)',
            }}
            onPointerDown={startDrag}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <p
              style={{
                fontSize: `${currentSlide.fontSizePx}px`,
                fontFamily: fontFamilies[currentSlide.fontStyle] || fontFamilies.modern,
                color: currentSlide.overlayColorHex || '#FFFFFF',
              }}
            >
              {currentSlide.overlayText}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={() => onPlayToggle(!isPlaying)}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors"
        >
          <div className="h-16 w-16 rounded-full bg-white/90 flex items-center justify-center shadow-2xl">
            {isPlaying ? <Pause className="h-6 w-6 text-slate-900" /> : <Play className="h-6 w-6 text-slate-900" />}
          </div>
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Timeline</span>
          <span>{progressLabel}</span>
        </div>
        <input
          type="range"
          min={0}
          max={totalDuration || 1}
          step={0.1}
          value={currentTime}
          onChange={(event) => onSeek(Number(event.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}
