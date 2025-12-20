import { GripVertical, Trash2 } from 'lucide-react';
import type { Slide } from './types';

type SlideListProps = {
  slides: Slide[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (nextSlides: Slide[]) => void;
  onRemove: (id: string) => void;
};

export function SlideList({ slides, selectedId, onSelect, onReorder, onRemove }: SlideListProps) {
  const handleDrop = (dragId: string, targetId: string) => {
    const dragIndex = slides.findIndex((s) => s.id === dragId);
    const targetIndex = slides.findIndex((s) => s.id === targetId);
    if (dragIndex === -1 || targetIndex === -1 || dragIndex === targetIndex) return;
    const next = [...slides];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
  };

  return (
    <div className="space-y-3">
      {slides.map((slide, index) => (
        <div
          key={slide.id}
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const dragId = event.dataTransfer.getData('text/plain');
            if (dragId) handleDrop(dragId, slide.id);
          }}
          onClick={() => onSelect(slide.id)}
          className={`group relative flex items-center gap-3 rounded-2xl border-2 p-3 transition-all ${
            selectedId === slide.id ? 'border-purple-500 bg-purple-50' : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="h-14 w-20 rounded-xl bg-slate-100 overflow-hidden">
            <img src={slide.imageSrc} alt={`Slide ${index + 1}`} className="h-full w-full object-cover" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-slate-900">Slide {index + 1}</p>
            <p className="text-xs text-slate-500">{slide.durationSec}s</p>
          </div>
          <div className="flex items-center gap-2 text-slate-400">
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData('text/plain', slide.id);
              }}
              className="rounded-lg p-1 hover:bg-slate-100 cursor-grab active:cursor-grabbing"
              aria-label="Drag to reorder"
              title="Drag to reorder"
            >
              <GripVertical className="h-4 w-4" />
            </button>
            {slides.length > 1 && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(slide.id);
                }}
                className="rounded-lg p-1 text-red-500 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
