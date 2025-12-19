import { Type, Wand2, MoveVertical } from 'lucide-react';
import type { Slide, TextPosition } from './types';

type SlideEditorProps = {
  slide: Slide | null;
  onUpdate: (updates: Partial<Slide>) => void;
};

const fontStyles = [
  { id: 'modern', label: 'Modern' },
  { id: 'classic', label: 'Classic' },
  { id: 'bold', label: 'Bold' },
  { id: 'script', label: 'Script' },
] as const;

const positionOptions: TextPosition[] = ['top', 'center', 'bottom'];

const isValidHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value.trim());

export function SlideEditor({ slide, onUpdate }: SlideEditorProps) {
  if (!slide) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        Select a slide to edit its text overlay.
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl space-y-6">
      <div className="flex items-center gap-2">
        <Type className="h-5 w-5 text-slate-600" />
        <h4 className="text-slate-900">Edit Slide</h4>
      </div>

      <div className="space-y-5">
        <div>
          <label className="block text-sm text-slate-700 mb-2">Text Overlay</label>
          <input
            type="text"
            value={slide.overlayText}
            onChange={(event) => onUpdate({ overlayText: event.target.value })}
            placeholder="Add text for this slide..."
            className="w-full rounded-xl border-2 border-slate-200 px-4 py-3 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-2">Text Color</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={isValidHex(slide.overlayColorHex || '#FFFFFF') ? slide.overlayColorHex : '#FFFFFF'}
              onChange={(event) => onUpdate({ overlayColorHex: event.target.value })}
              className="h-10 w-14 rounded-xl border-2 border-slate-200 bg-white px-2"
            />
            <input
              type="text"
              value={slide.overlayColorHex}
              onChange={(event) => onUpdate({ overlayColorHex: event.target.value })}
              placeholder="#FFFFFF"
              className="flex-1 rounded-xl border-2 border-slate-200 px-4 py-3 text-sm focus:border-purple-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-700 mb-2">Font Style</label>
            <div className="grid grid-cols-2 gap-2">
              {fontStyles.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  onClick={() => onUpdate({ fontStyle: font.id })}
                  className={`rounded-xl border-2 px-3 py-2 text-xs transition-all ${
                    slide.fontStyle === font.id
                      ? 'border-purple-500 bg-purple-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {font.label}
                </button>
              ))}
            </div>
          </div>

          <div />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-700 mb-2">Font Size</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={18}
                max={96}
                value={slide.fontSizePx}
                onChange={(event) => onUpdate({ fontSizePx: Number(event.target.value) })}
                className="flex-1"
              />
              <span className="text-xs text-slate-500 w-12">{slide.fontSizePx}px</span>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-2">Text Position</label>
            <div className="grid grid-cols-3 gap-2">
              {positionOptions.map((position) => (
                <button
                  key={position}
                  type="button"
                  onClick={() => onUpdate({ position })}
                  className={`rounded-xl px-3 py-2 text-xs capitalize transition-all ${
                    slide.position === position
                      ? 'bg-purple-500 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {position}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <Wand2 className="h-4 w-4 text-purple-500" />
          <span>Drag the text inside the preview to place it.</span>
          <MoveVertical className="h-4 w-4 text-slate-400" />
          <span>Drag slides in the list to reorder the timeline.</span>
        </div>
      </div>
    </div>
  );
}
