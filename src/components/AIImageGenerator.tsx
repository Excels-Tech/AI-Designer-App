import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronUp,
  Loader2,
  Settings2,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { ViewId } from '../services/designStore';

interface AIImageGeneratorProps {
  onGenerate: (result: GenerateResponse, request: GenerateRequest) => void;
}

type StyleId = 'realistic' | '3d' | 'lineart' | 'watercolor';
type Resolution = 512 | 1024 | 1536 | 2048;

const styleOptions: { id: StyleId; label: string; preview: string }[] = [
  {
    id: 'realistic',
    label: 'Realistic',
    preview: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=200&h=200&fit=crop',
  },
  {
    id: '3d',
    label: '3D Render',
    preview: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=200&h=200&fit=crop',
  },
  {
    id: 'lineart',
    label: 'Line Art',
    preview: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=200&h=200&fit=crop',
  },
  {
    id: 'watercolor',
    label: 'Watercolor',
    preview: 'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=200&h=200&fit=crop',
  },
];

const viewAngles: { id: ViewId; label: string; icon: string }[] = [
  { id: 'front', label: 'Front View', icon: '[F]' },
  { id: 'back', label: 'Back View', icon: '[B]' },
  { id: 'left', label: 'Left Side', icon: '<' },
  { id: 'right', label: 'Right Side', icon: '>' },
  { id: 'threeQuarter', label: '3/4 View', icon: '3/4' },
  { id: 'top', label: 'Top View', icon: '^' },
];

const resolutionOptions: Resolution[] = [512, 1024, 1536, 2048];

interface GenerateResponse {
  combinedImage: string;
  error?: string;
  views: { view: string; image: string }[];
  meta?: {
    baseView: string;
    style: string;
    resolution: number;
  };
}

export interface GenerateRequest {
  prompt: string;
  style: StyleId;
  resolution: Resolution;
  views: ViewId[];
}

export function AIImageGenerator({ onGenerate }: AIImageGeneratorProps) {
  const [prompt, setPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<StyleId>('realistic');
  const [resolution, setResolution] = useState<Resolution>(1024);
  const [selectedViews, setSelectedViews] = useState<ViewId[]>(['front', 'back', 'left', 'right']);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const abortController = useRef<AbortController | null>(null);

  const viewCountLabel = useMemo(
    () => `${selectedViews.length} view${selectedViews.length === 1 ? '' : 's'} selected`,
    [selectedViews.length]
  );

  const toggleView = (viewId: ViewId) => {
    setSelectedViews((prev) =>
      prev.includes(viewId) ? prev.filter((id) => id !== viewId) : [...prev, viewId]
    );
  };

  useEffect(() => () => abortController.current?.abort(), []);

  const startProgressTicker = (steps: string[]) => {
    let index = 0;
    setStatus(steps[0]);
    setProgress(6);

    const timer = window.setInterval(() => {
      index = Math.min(index + 1, steps.length - 1);
      setStatus(steps[index]);
      const nextProgress = Math.min(90, Math.round(((index + 1) / (steps.length + 1)) * 100));
      setProgress(nextProgress);
    }, 1200);

    return timer;
  };

  const handleGenerate = async () => {
    if (!prompt.trim() || selectedViews.length === 0) return;

    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;

    setIsGenerating(true);
    setError('');
    setProgress(6);

    const steps = [
      'Preparing prompts...',
      ...selectedViews.map((_, idx) => `Generating view ${idx + 1}/${selectedViews.length}...`),
      'Composing multi-view image...',
    ];

    const ticker = startProgressTicker(steps);

    try {
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          style: selectedStyle,
          resolution,
          views: selectedViews,
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let payload: GenerateResponse | null = null;
      try {
        payload = JSON.parse(raw) as GenerateResponse;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error((payload as any)?.error || raw || 'Server error');
      }

      if (!payload) {
        throw new Error('Unexpected empty response from server.');
      }

      const requestPayload: GenerateRequest = {
        prompt: prompt.trim(),
        style: selectedStyle,
        resolution,
        views: selectedViews,
      };

      setProgress(100);
      setStatus('Done');
      onGenerate(payload, requestPayload);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        setError('Generation cancelled.');
      } else {
        setError((err as Error).message || 'Unable to generate image right now.');
      }
    } finally {
      window.clearInterval(ticker);
      setIsGenerating(false);
      abortController.current = null;
      setTimeout(() => setProgress(0), 500);
    }
  };

  const disabled = !prompt.trim() || selectedViews.length === 0 || isGenerating;

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h2 className="text-slate-900">AI Image Generator</h2>
          </div>
          <p className="text-slate-600">Describe your vision and watch it come to life</p>
        </div>

        {/* Main Content */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-8">
          {/* Prompt Input */}
          <div className="mb-6">
            <label className="block text-sm text-slate-700 mb-3">
              Describe what you want to create
            </label>
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

          {/* Advanced Options Toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 mb-4 transition-colors"
          >
            <Settings2 className="w-4 h-4" />
            Advanced Options
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {/* Advanced Options */}
          {showAdvanced && (
            <div className="mb-6 p-6 bg-slate-50 rounded-2xl space-y-6">
              {/* Resolution */}
              <div>
                <label className="block text-sm text-slate-700 mb-3">Resolution</label>
                <div className="flex gap-3">
                  {resolutionOptions.map((res) => (
                    <button
                      key={res}
                      onClick={() => setResolution(res)}
                      className={`px-4 py-2 rounded-xl text-sm transition-all ${
                        resolution === res
                          ? 'bg-purple-500 text-white shadow-lg shadow-purple-500/30'
                          : 'bg-white text-slate-600 border border-slate-200 hover:border-purple-300'
                      }`}
                    >
                      {res}x{res}
                    </button>
                  ))}
                </div>
              </div>

              {/* View Angles Selection */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Camera className="w-4 h-4 text-slate-600" />
                  <label className="block text-sm text-slate-700">
                    Select View Angles ({viewCountLabel})
                  </label>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {viewAngles.map((view) => (
                    <button
                      key={view.id}
                      onClick={() => toggleView(view.id)}
                      className={`p-3 rounded-xl border-2 transition-all text-left ${
                        selectedViews.includes(view.id)
                          ? 'border-purple-500 bg-purple-50'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{view.icon}</span>
                        <span className="text-sm text-slate-900">{view.label}</span>
                      </div>
                      {selectedViews.includes(view.id) && (
                        <div className="mt-1 text-xs text-purple-600">Selected</div>
                      )}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  We generate one design and render all selected angles of the same item into one high-resolution image.
                </p>
              </div>
            </div>
          )}

          {/* Style Selector */}
          <div className="mb-8">
            <label className="block text-sm text-slate-700 mb-4">Choose Style</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {styleOptions.map((style) => (
                <button
                  key={style.id}
                  onClick={() => setSelectedStyle(style.id)}
                  className={`group relative overflow-hidden rounded-2xl transition-all ${
                    selectedStyle === style.id
                      ? 'ring-4 ring-purple-500 ring-offset-2'
                      : 'hover:ring-2 hover:ring-slate-300'
                  }`}
                >
                  <div className="aspect-square bg-slate-100">
                    <img
                      src={style.preview}
                      alt={style.label}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div
                    className={`absolute inset-0 flex items-center justify-center transition-colors ${
                      selectedStyle === style.id
                        ? 'bg-purple-500/80'
                        : 'bg-black/50 group-hover:bg-black/60'
                    }`}
                  >
                    <span className="text-white text-sm">{style.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGenerate}
            disabled={disabled}
            className="w-full bg-gradient-to-r from-violet-500 to-purple-500 text-white py-4 rounded-2xl hover:shadow-2xl hover:shadow-purple-500/40 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Generating {selectedViews.length} views...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 group-hover:rotate-12 transition-transform" />
                <span>Generate {selectedViews.length} View Image</span>
              </>
            )}
          </button>

          {/* Progress Indicator */}
          {isGenerating && (
            <div className="mt-6">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="text-slate-600">{status || 'Working...'}</span>
                <span className="text-purple-600">{progress}%</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-center gap-3 p-3 border border-rose-200 bg-rose-50 text-rose-700 rounded-xl text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Tips */}
        <div className="mt-6 p-6 bg-gradient-to-br from-blue-50 to-cyan-50 rounded-2xl border border-blue-100">
          <h4 className="text-slate-900 mb-2">Pro Tips</h4>
          <ul className="text-sm text-slate-600 space-y-1">
            <li>Be specific about colors, styles, and details.</li>
            <li>Include lighting and mood descriptions.</li>
            <li>Select multiple view angles for complete product visualization.</li>
            <li>Higher resolution = better quality for cropping individual views.</li>
            <li>Realistic style works best for automatic layer separation in the editor.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
