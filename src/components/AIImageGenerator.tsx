import { useMemo, useState, useEffect } from 'react';
import { Sparkles, Wand2, Loader2, Camera, AlertCircle, ImageDown, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { authFetch, getUserId } from '../utils/auth';

type StyleKey = 'realistic' | '3d' | 'lineart' | 'watercolor';
type ViewKey = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'top';

interface AIImageGeneratorProps {
  onGenerate?: (composite: string) => void;
}

interface GeneratedImage {
  view: ViewKey;
  src: string;
}

interface GenerateResponse {
  composite: string;
  images: GeneratedImage[];
  designId?: string;
}

const resolutionOptions = [512, 1024, 1536, 2048];

const styleOptions: { id: StyleKey; label: string; preview: string; helper: string }[] = [
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

const viewOptions: { id: ViewKey; label: string; description: string }[] = [
  { id: 'front', label: 'Front View', description: 'Head-on perspective' },
  { id: 'back', label: 'Back View', description: 'Rear details' },
  { id: 'left', label: 'Left Side', description: 'Profile angle' },
  { id: 'right', label: 'Right Side', description: 'Opposite profile' },
  { id: 'threeQuarter', label: '3/4 View', description: 'Angled depth' },
  { id: 'top', label: 'Top View', description: 'Overhead' },
];

const viewLabel = (view: ViewKey) => viewOptions.find((v) => v.id === view)?.label ?? view;

export function AIImageGenerator({ onGenerate }: AIImageGeneratorProps) {
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<StyleKey>('realistic');
  const [resolution, setResolution] = useState<number>(1024);
  const [selectedViews, setSelectedViews] = useState<ViewKey[]>(['front', 'back', 'left', 'right']);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [savedDesignId, setSavedDesignId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [designName, setDesignName] = useState('');
  const [hasResultFlag, setHasResultFlag] = useState(false);

  useEffect(() => {
    setUserId(getUserId());
  }, []);

  const hasResult = hasResultFlag || Boolean(result?.composite && result?.images?.length);

  const selectedViewsLabel = useMemo(
    () => `Select View Angles (${selectedViews.length} selected)`,
    [selectedViews.length]
  );

  const toggleView = (viewId: ViewKey) => {
    setSelectedViews((prev) =>
      prev.includes(viewId) ? prev.filter((id) => id !== viewId) : [...prev, viewId]
    );
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt.');
      return;
    }
    if (selectedViews.length === 0) {
      setError('Select at least one view.');
      return;
    }

    setIsGenerating(true);
    setStatusMessage('Sending prompt to Gemini...');
    setError(null);
    setSaveMessage(null);
    setSaveError(null);
    setSavedDesignId(null);
    setDesignName('');

    try {
      const response = await authFetch('/api/generate-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          style,
          views: selectedViews,
          resolution,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Generation failed.');
      }

      const payload: GenerateResponse = await response.json();
      setResult(payload);
      setHasResultFlag(Boolean(payload?.composite && payload?.images?.length));
      setStatusMessage('Composite generated and cropped automatically.');
      onGenerate?.(payload.composite);
    } catch (err: any) {
      setError(err?.message || 'Something went wrong while generating images.');
        setResult(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveDesign = async () => {
    if (!result) return;
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
      const payload = {
        name: finalName.slice(0, 60),
        title: finalName.slice(0, 60),
        prompt: prompt.trim(),
        userId: uid,
        style,
        resolution,
        views: selectedViews,
        composite: result.composite,
        images: result.images.map((img) => ({ view: img.view, src: img.src })),
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
      setSavedDesignId(data.id);
      setSaveMessage('Saved to My Designs.');
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save design.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownloadAll = () => {
    if (!result) return;
    if (savedDesignId) {
      const uid = userId || getUserId();
      authFetch(`/api/designs/${savedDesignId}/download.zip`, {
        method: 'GET',
      })
        .then(async (resp) => {
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to download.');
          }
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `design-${savedDesignId}.zip`;
          link.click();
          URL.revokeObjectURL(url);
        })
        .catch((err) => setSaveError(err?.message || 'Failed to download.'));
      return;
    }
    // Fallback for unsaved designs: download individual PNGs
    result.images.forEach((image) => {
      const link = document.createElement('a');
      link.href = image.src;
      link.download = `${image.view}.png`;
      link.click();
    });
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-slate-900">Multi-View AI Image Generator</h2>
            <p className="text-slate-600 text-sm">
              Generate one composite image, then automatically crop out each view.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-8 space-y-8">
          <div>
            <label className="block text-sm text-slate-700 mb-2">Describe what you want</label>
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g., A futuristic streetwear hoodie design with cyberpunk aesthetics, neon colors, and geometric patterns..."
                className="w-full h-32 px-4 py-3 pr-12 rounded-2xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none resize-none transition-colors"
              />
              <Wand2 className="absolute right-4 top-4 w-5 h-5 text-slate-400" />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <p className="text-sm text-slate-700 mb-2">Resolution</p>
                <div className="flex flex-wrap gap-2">
                  {resolutionOptions.map((res) => (
                    <button
                      key={res}
                      onClick={() => setResolution(res)}
                      className={clsx(
                        'px-4 py-2 rounded-xl text-sm border transition-all',
                        resolution === res
                          ? 'bg-purple-500 text-white border-purple-500 shadow-lg shadow-purple-500/30'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-purple-300'
                      )}
                    >
                      {res}x{res}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Camera className="w-4 h-4 text-slate-600" />
                  <p className="text-sm text-slate-700">{selectedViewsLabel}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {viewOptions.map((view) => {
                    const active = selectedViews.includes(view.id);
                    return (
                      <button
                        key={view.id}
                        onClick={() => toggleView(view.id)}
                        className={clsx(
                          'p-2 rounded-xl border-2 text-left transition-all',
                          active
                            ? 'border-purple-500 bg-purple-50 shadow-sm shadow-purple-200'
                            : 'border-slate-200 hover:border-slate-300 bg-white'
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-slate-900">{view.label}</span>
                          {active && <span className="text-[10px] text-purple-600">Selected</span>}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 leading-snug">{view.description}</p>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  All selected views will be arranged in a single composite image and auto-cropped.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm text-slate-700">Style</p>
              <div className="grid grid-cols-2 gap-3">
                {styleOptions.map((item) => {
                  const active = style === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setStyle(item.id)}
                      className={clsx(
                        'group flex items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition-all',
                        active
                          ? 'border-purple-500 bg-purple-50 shadow-sm shadow-purple-200'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      )}
                    >
                      <div className="h-12 w-12 rounded-lg overflow-hidden bg-slate-100 flex-none">
                        <img src={item.preview} alt={item.label} className="h-full w-full object-cover" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-slate-900">{item.label}</p>
                        <p className="text-[11px] text-slate-500 line-clamp-1">{item.helper}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full bg-gradient-to-r from-violet-500 to-purple-500 text-white py-4 rounded-2xl hover:shadow-2xl hover:shadow-purple-500/40 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Generating {selectedViews.length} view image...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                <span>Generate {selectedViews.length} View Image</span>
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

        {hasResult && (
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-start md:items-center">
              <div>
                <p className="text-slate-900 font-medium">Composite Preview</p>
                <p className="text-sm text-slate-500">
                  {selectedViews.length} views · {resolution}x{resolution} · {styleOptions.find((s) => s.id === style)?.label}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 items-center justify-end overflow-visible">
                <button
                  onClick={handleDownloadAll}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800 inline-flex items-center gap-2 whitespace-nowrap flex-none"
                >
                  <ImageDown className="w-4 h-4" />
                  Download All
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-900">
              <img src={result.composite} alt="Composite" className="w-full h-full object-contain max-h-[480px] mx-auto" />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
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

            {(saveMessage || saveError) && (
              <div
                className={clsx(
                  'rounded-xl border px-4 py-3 text-sm',
                  saveMessage ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'
                )}
              >
                {saveMessage || saveError}
              </div>
            )}

            <div>
              <p className="text-slate-900 font-medium mb-3">Cropped Views</p>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
                {result.images.map((image) => (
                  <div
                    key={image.view}
                    className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50 shadow-sm"
                  >
                    <div className="aspect-square bg-white">
                      <img src={image.src} alt={viewLabel(image.view)} className="w-full h-full object-cover" />
                    </div>
                    <div className="p-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-900">{viewLabel(image.view)}</p>
                        <p className="text-xs text-slate-500">Auto-cropped from composite</p>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
