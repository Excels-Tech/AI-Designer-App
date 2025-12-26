import type { DesignCardItem } from './DesignsGrid';

type DesignEditorPanelProps = {
  selected: DesignCardItem | null;
  designScale: number;
  onClear: () => void;
};

export function DesignEditorPanel({ selected, designScale, onClear }: DesignEditorPanelProps) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden">
      <div className="border-b border-slate-200 px-6 py-4">
        <p className="text-slate-900 font-medium">Design Editor</p>
        <p className="text-xs text-slate-500">Applies to the selected design on the canvas.</p>
      </div>
      <div className="p-6 space-y-4">
        {selected ? (
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl overflow-hidden bg-slate-100 flex-none">
              <img src={selected.thumbnail} alt={selected.title} className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0">
              <p className="text-sm text-slate-900 line-clamp-1">{selected.title}</p>
              <p className="text-xs text-slate-500">Scale: {Math.round(designScale * 100)}%</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">No design selected.</p>
        )}

        <button
          type="button"
          onClick={onClear}
          className="w-full px-4 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
        >
          Back to Text Editor / Clear design selection
        </button>
      </div>
    </div>
  );
}

