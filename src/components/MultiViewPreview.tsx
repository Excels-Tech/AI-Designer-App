import { useMemo, useState } from 'react';
import { ZoomIn, Download, Crop, ArrowLeft, Maximize2, Info, AlertTriangle } from 'lucide-react';
import { getLayout } from '../utils/multiViewLayout';

interface MultiViewPreviewProps {
  result: {
    combinedImage: string;
    views: { view: string; image: string }[];
  };
  request: any;
  errorMessage?: string;
  isRegenerating?: boolean;
  onRegenerate?: () => void;
  onSaveVersion?: () => Promise<void> | void;
  onCropStart: () => void;
  onBack: () => void;
}

export function MultiViewPreview({
  result,
  request,
  errorMessage,
  isRegenerating,
  onRegenerate,
  onSaveVersion,
  onCropStart,
  onBack,
}: MultiViewPreviewProps) {
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [showInfo, setShowInfo] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [toast, setToast] = useState<string | null>(null);
  const layout = useMemo(() => getLayout(result.views.length), [result.views.length]);
  const slots = useMemo(() => {
    const total = layout.cols * layout.rows;
    const filled = result.views.map((v, idx) => ({
      label: v.view === 'threeQuarter' ? '3/4' : v.view,
      index: idx + 1,
      filled: true,
    }));
    if (filled.length < total) {
      for (let i = filled.length; i < total; i++) {
        filled.push({ label: 'unused', index: i + 1, filled: false });
      }
    }
    return filled;
  }, [layout, result.views]);

  const handleSave = async () => {
    if (!onSaveVersion || saveState === 'saving') return;
    try {
      setSaveState('saving');
      await onSaveVersion();
      setSaveState('saved');
      setToast('Saved');
      window.setTimeout(() => setSaveState('idle'), 2000);
      window.setTimeout(() => setToast(null), 2000);
    } catch (err) {
      setSaveState('idle');
      setToast((err as Error).message || 'Unable to save');
      window.setTimeout(() => setToast(null), 2500);
    }
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Back to Generator</span>
          </button>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-slate-900 mb-2">Multi-View Preview</h2>
              <p className="text-slate-600">Your AI-generated image with multiple perspectives</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={!onSaveVersion || saveState === 'saving'}
                className="px-4 py-2 bg-white border border-slate-200 rounded-xl hover:shadow-lg transition-all flex items-center gap-2 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                <span className="text-sm">
                  {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved ✓' : 'Save Version'}
                </span>
              </button>
              <button
                onClick={onCropStart}
                className="px-6 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2"
              >
                <Crop className="w-4 h-4" />
                <span className="text-sm">Crop & Edit</span>
              </button>
            </div>
          </div>
        </div>

        {errorMessage && (
          <div className="mb-4 flex items-center gap-3 p-3 border border-rose-200 bg-rose-50 text-rose-700 rounded-xl text-sm">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Info Banner */}
        {showInfo && (
          <div className="mb-6 p-4 bg-gradient-to-r from-violet-500/10 to-purple-500/10 border border-purple-200 rounded-2xl flex items-start gap-3">
            <Info className="w-5 h-5 text-purple-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-slate-700">
                This image contains 4 different views of your design. Use the crop tool to extract individual views for editing.
              </p>
            </div>
            <button
              onClick={() => setShowInfo(false)}
              className="text-slate-400 hover:text-slate-600"
            >
              ×
            </button>
          </div>
        )}

        {/* Main Image Preview */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden">
          {/* Image */}
          <div className="relative bg-slate-900 aspect-[16/10]">
            <img
              src={result.combinedImage}
              alt="Generated multi-view"
              className="w-full h-full object-contain"
            />

            {/* Overlay Grid */}
            <div
              className="absolute inset-0 gap-px"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
              }}
            >
              {slots.map((slot) => (
                <div
                  key={slot.index}
                  className={`border-2 border-dashed border-white/20 hover:border-purple-400 hover:bg-purple-500/10 transition-all cursor-pointer group ${
                    slot.filled ? '' : 'opacity-60'
                  }`}
                >
                  <div className="absolute top-2 left-2 bg-black/50 backdrop-blur-sm px-2 py-1 rounded text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                    {slot.filled ? slot.label : 'unused'}
                  </div>
                </div>
              ))}
            </div>

            {/* Zoom Button */}
            <button
              onClick={() => setShowFullscreen(!showFullscreen)}
              className="absolute top-4 right-4 w-10 h-10 bg-black/50 backdrop-blur-sm rounded-xl flex items-center justify-center text-white hover:bg-black/70 transition-all"
            >
              {showFullscreen ? <ZoomIn className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          </div>

          {/* Actions Bar */}
          <div className="p-6 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500 mb-1">Generated Image</p>
                <p className="text-sm text-slate-900">
                  {result.views.length} views - {request?.resolution}px - {request?.style} style
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onRegenerate}
                  disabled={!onRegenerate || isRegenerating}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                </button>
                <button
                  onClick={handleSave}
                  disabled={!onSaveVersion || saveState === 'saving'}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved ✓' : 'Save Version'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* View Grid Indicator */}
        <div className="mt-6 p-6 bg-white rounded-2xl border border-slate-200">
          <h4 className="text-slate-900 mb-4">View Layout Guide</h4>
          <div
            className="grid gap-3 max-w-3xl"
            style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
          >
            {slots.map((slot) => (
              <div
                key={slot.index}
                className={`flex items-center gap-3 p-3 rounded-xl ${
                  slot.filled ? 'bg-slate-50' : 'bg-slate-100 opacity-70'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center text-white text-sm">
                  {slot.index}
                </div>
                <span className="text-sm text-slate-600">
                  {slot.filled ? slot.label : 'Unused slot'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-3 bg-slate-900 text-white rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
