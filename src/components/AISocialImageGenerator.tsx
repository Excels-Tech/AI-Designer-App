import { useEffect, useMemo, useRef, useState } from 'react';
import { AspectRatio } from './ui/aspect-ratio';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { toast } from 'sonner';
import { Download, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { authFetch } from '../utils/auth';
import {
  formatRatioLabel,
  getAllPlatformPresets,
  type SocialDesignType,
  type SocialPlatform,
  type SocialPreset,
} from '../config/socialMediaPresets';

type GeneratedImage = {
  id: string;
  url: string;
  width: number;
  height: number;
  prompt: string;
  createdAt: string;
  designId?: string;
};

type GenerationBatch = {
  id: string;
  createdAt: string;
  platform: SocialPlatform;
  designType: SocialDesignType;
  presetId?: string;
  width: number;
  height: number;
  prompt: string;
  images: GeneratedImage[];
};

interface AISocialImageGeneratorProps {
  onUseInEditor: (imageDataUrl: string) => void;
}

const PLATFORMS: SocialPlatform[] = ['LinkedIn', 'Instagram', 'YouTube', 'Facebook', 'Website', 'Custom'];

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toSlug(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchUrlToDataUrl(url: string) {
  const res = await authFetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load image.');
  }
  const blob = await res.blob();
  return await blobToDataUrl(blob);
}

async function downloadViaFetch(url: string, filename: string) {
  const res = await authFetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed.');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function AISocialImageGenerator({ onUseInEditor }: AISocialImageGeneratorProps) {
  const [designType, setDesignType] = useState<SocialDesignType>('post');
  const [platform, setPlatform] = useState<SocialPlatform>('LinkedIn');
  const [presetId, setPresetId] = useState<string>('');
  const [width, setWidth] = useState<number>(1200);
  const [height, setHeight] = useState<number>(627);
  const [lockAspect, setLockAspect] = useState<boolean>(true);
  const lockedRatioRef = useRef<number>(1200 / 627);
  const [prompt, setPrompt] = useState('');


  const [isGenerating, setIsGenerating] = useState(false);
  const [variantMode, setVariantMode] = useState<'random'|'none'|'seed'|'custom'>('random');
  const [variantSeed, setVariantSeed] = useState('');
  const [customVariant, setCustomVariant] = useState('');
  const [history, setHistory] = useState<GenerationBatch[]>([]);
  const [livePreviewSrc, setLivePreviewSrc] = useState<string | null>(null);
  const lastPayloadRef = useRef<any | null>(null);

  // Use combined presets for the selected platform
  const presets = useMemo(() => getAllPlatformPresets(platform), [platform]);

  const selectedPreset: SocialPreset | null = useMemo(() => {
    if (!presetId) return null;
    return presets.find((p) => p.id === presetId) ?? null;
  }, [presetId, presets]);

  useEffect(() => {
    const next = presets[0];
    if (!next) {
      setPresetId('');
      if (platform === 'Custom') {
        setLockAspect(false);
      }
      return;
    }
    setLockAspect(true); // Default to locked for standard platforms
    setPresetId(next.id);
    setWidth(next.width);
    setHeight(next.height);
    if (next.designType) setDesignType(next.designType);
    if (lockAspect) lockedRatioRef.current = next.width / next.height;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]); // Removed designType from dependencies

  useEffect(() => {
    if (!lockAspect) return;
    const ratio = width > 0 && height > 0 ? width / height : 1;
    if (Number.isFinite(ratio) && ratio > 0) lockedRatioRef.current = ratio;
  }, [lockAspect, width, height]);

  const ratioLabel = useMemo(() => formatRatioLabel(width, height), [width, height]);
  const aspectRatio = useMemo(() => (width > 0 && height > 0 ? width / height : 1), [width, height]);

  const setWidthLocked = (val: string) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      const w = clampInt(n, 1, 4096); // Allow intermediate small numbers
      setWidth(w);
      setPresetId('');
      if (lockAspect && n >= 64) {
        setHeight(clampInt(Math.round(w / lockedRatioRef.current), 64, 4096));
      }
    } else if (val === '') {
      setWidth(0);
    }
  };

  const setHeightLocked = (val: string) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      const h = clampInt(n, 1, 4096);
      setHeight(h);
      setPresetId('');
      if (lockAspect && n >= 64) {
        setWidth(clampInt(Math.round(h * lockedRatioRef.current), 64, 4096));
      }
    } else if (val === '') {
      setHeight(0);
    }
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setWidth(preset.width);
    setHeight(preset.height);
    if (preset.designType) setDesignType(preset.designType);
    if (lockAspect) lockedRatioRef.current = preset.width / preset.height;
  };

  const callGenerate = async (mode: 'generate' | 'regenerate') => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      toast('Please enter a prompt.');
      return;
    }

    const basePayload = mode === 'regenerate' ? lastPayloadRef.current : null;
    const payload = basePayload ?? {
      prompt: trimmedPrompt,
      width,
      height,
      platform,
      designType, // Now correctly uses the state derived from the preset
      presetId: presetId || undefined,
      variant: ((): string => {
        if (variantMode === 'none') return 'none';
        if (variantMode === 'seed' && variantSeed.trim()) return `seed:${variantSeed.trim()}`;
        if (variantMode === 'custom' && customVariant.trim()) return customVariant.trim();
        return 'random';
      })(),
    };
    payload.variationSeed = `${Date.now()}-${Math.random()}`;

    setIsGenerating(true);
    try {
      const res = await authFetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Generation failed.');
      if (!Array.isArray(data.images) || data.images.length < 1) throw new Error('No images returned.');

      const batch: GenerationBatch = {
        id: String(data.batchId || crypto.randomUUID()),
        createdAt: new Date().toISOString(),
        platform: payload.platform,
        designType: payload.designType,
        presetId: payload.presetId,
        width: payload.width,
        height: payload.height,
        prompt: payload.prompt,
        images: data.images as GeneratedImage[],
      };

      lastPayloadRef.current = { ...payload, variationSeed: undefined };
      setLivePreviewSrc(String((data.images[0] as any)?.url || ''));
      setHistory((prev) => [batch, ...prev].slice(0, 10));
      toast(mode === 'regenerate' ? 'Regenerated' : 'Generated');
    } catch (err: any) {
      toast(err?.message || 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="app-shimmer-sweep w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-slate-900">AI Image Generator</h2>
            <p className="text-slate-600 text-sm">Social Media Designer — generate platform-sized visuals from a prompt.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <Card className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
            <div className="space-y-6">
              {/* Removed Design Type Tabs */}
              <div className="flex flex-wrap items-start gap-4">
                <div className="space-y-2">
                  <Label className="text-slate-700">Platform</Label>
                  <Select value={platform} onValueChange={(v: string) => setPlatform(v as SocialPlatform)}>
                    <SelectTrigger className="rounded-xl w-fit min-w-[100px]">
                      <SelectValue placeholder="Select platform" />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORMS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-slate-700">Style Variant</Label>
                  <div className="flex items-center gap-3">
                    <select
                      className="rounded-xl border-slate-200 p-2"
                      value={variantMode}
                      onChange={(e) => setVariantMode(e.target.value as any)}
                    >
                      <option value="random">Random</option>
                      <option value="seed">Seed</option>
                      <option value="custom">Custom</option>
                      <option value="none">None</option>
                    </select>

                    {variantMode === 'seed' && (
                      <Input className="rounded-xl w-[160px]" placeholder="Seed value" value={variantSeed} onChange={(e) => setVariantSeed(e.target.value)} />
                    )}

                    {variantMode === 'custom' && (
                      <Input className="rounded-xl w-[220px]" placeholder="Custom variant description" value={customVariant} onChange={(e) => setCustomVariant(e.target.value)} />
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-slate-700">Lock Aspect</Label>
                    <Switch
                      checked={lockAspect}
                      onCheckedChange={setLockAspect}
                      className="data-[state=checked]:bg-purple-600"
                    />
                  </div>
                  <Select value={presetId || ''} onValueChange={applyPreset}>
                    <SelectTrigger className="rounded-xl w-fit min-w-[120px]">
                      <SelectValue placeholder={presets.length ? 'Select preset' : 'Custom Sizes'} />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.length ? (
                        presets.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.label} — {p.width}×{p.height} ({p.ratioLabel})
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="__none__" disabled>
                          No presets for this selection
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {selectedPreset?.notes ? <p className="text-xs text-slate-500">{selectedPreset.notes}</p> : null}
                </div>

                <div className="space-y-2">
                  <Label className="text-slate-700">Width (px)</Label>
                  <Input
                    className="rounded-xl w-[100px]"
                    inputMode="numeric"
                    value={width || ''}
                    readOnly={platform !== 'Custom'}
                    onChange={(e) => setWidthLocked(e.target.value)}
                    onBlur={() => {
                      if (width < 64) setWidth(64);
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-slate-700">Height (px)</Label>
                  <Input
                    className="rounded-xl w-[100px]"
                    inputMode="numeric"
                    value={height || ''}
                    readOnly={platform !== 'Custom'}
                    onChange={(e) => setHeightLocked(e.target.value)}
                    onBlur={() => {
                      if (height < 64) setHeight(64);
                    }}
                  />
                </div>
              </div>



              <div className="space-y-2">
                <Label className="text-slate-700">Prompt</Label>
                <div className="flex flex-row items-end gap-3">
                  <Textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the image you want..."
                    className="min-h-[80px] rounded-2xl flex-1"
                  />
                  <Button
                    size="default"
                    className="rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 shadow-lg shadow-purple-500/30 h-[80px] w-[200px] shrink-0 flex flex-row items-center justify-center gap-2 transition-all active:scale-95"
                    onClick={() => void callGenerate('generate')}
                    disabled={isGenerating}
                  >
                    {isGenerating ? (
                      <Loader2 className="w-5 h-5 animate-spin shrink-0" />
                    ) : (
                      <Sparkles className="w-5 h-5 shrink-0" />
                    )}
                    <span className="font-bold whitespace-nowrap">Generate Image</span>
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <div className="lg:col-span-3 space-y-6">
            <Card className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-slate-900">Live Preview ({width}×{height})</h3>

                </div>

              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden shadow-inner">
                <AspectRatio ratio={aspectRatio}>
                  <div className="absolute inset-0 bg-gradient-to-br from-slate-100 via-white to-slate-100" />
                  {livePreviewSrc ? (
                    <img src={livePreviewSrc} alt="Live preview" className="absolute inset-0 w-full h-full object-contain" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
                      Generate an image to preview here.
                    </div>
                  )}
                </AspectRatio>
              </div>

              {livePreviewSrc && (
                <div className="flex justify-end pt-4">
                  <Button
                    size="default"
                    variant="outline"
                    className="h-10 rounded-xl shadow-sm bg-white hover:bg-purple-50/50 hover:shadow-lg hover:shadow-purple-500/10 hover:-translate-y-0.5 hover:border-purple-300 border-slate-200 px-5 transition-all duration-300 active:scale-95 group flex flex-row items-center gap-2 whitespace-nowrap"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      const filename = `ai-generated-${Date.now()}.png`;
                      if (livePreviewSrc.startsWith('data:')) {
                        downloadDataUrl(livePreviewSrc, filename);
                      } else {
                        void downloadViaFetch(livePreviewSrc, filename).catch((err) => toast(err?.message || 'Download failed.'));
                      }
                    }}
                  >
                    <Download className="h-4 w-4 text-slate-600 group-hover:text-purple-600 transition-colors shrink-0" />
                    <span className="font-semibold text-slate-700 group-hover:text-purple-600 transition-colors">Download Image</span>
                  </Button>
                </div>
              )}
            </Card>

            <Card className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-slate-900">Generated Results</h3>
                  <p className="text-sm text-slate-500">Newest first • Keeps last 10 versions</p>
                </div>
                {history[0]?.images?.length ? (
                  <Button
                    variant="secondary"
                    className="rounded-xl"
                    onClick={() => setLivePreviewSrc(history[0]!.images[0]!.url)}
                    disabled={!history.length}
                  >
                    Latest to Preview
                  </Button>
                ) : null}
              </div>

              {!history.length ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">
                  Your generated versions will appear here.
                </div>
              ) : (
                <div className="space-y-6">
                  {history.map((batch) => (
                    <div key={batch.id} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="text-sm text-slate-900 truncate">
                            {batch.platform} • {batch.designType.toUpperCase()} • {batch.width}×{batch.height}
                          </p>
                          <p className="text-xs text-slate-500 truncate">{batch.prompt}</p>
                        </div>
                        <span className="text-xs text-slate-400">
                          {new Date(batch.createdAt).toLocaleString()}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
                        {batch.images.slice(0, 4).map((img) => (
                          <div
                            key={img.id}
                            className="rounded-2xl border border-slate-200 overflow-hidden bg-white hover:shadow-lg transition-shadow"
                          >
                            <div className="aspect-[4/3] bg-slate-50 overflow-hidden">
                              <img
                                src={img.url}
                                alt="Generated"
                                className="w-full h-full object-contain cursor-pointer"
                                onClick={() => setLivePreviewSrc(img.url)}
                              />
                            </div>
                            <div className="p-3 flex items-center justify-between gap-2">
                              <div className="text-xs text-slate-600">{img.width}×{img.height}</div>
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="rounded-xl h-8 bg-white hover:bg-purple-50/50 hover:shadow-md hover:border-purple-200 border border-transparent transition-all active:scale-95 group/btn"
                                  onClick={() => {
                                    const nameBase = toSlug(`${batch.platform}-${batch.designType}-${img.width}x${img.height}`) || 'image';
                                    const filename = `${nameBase}-${img.id}.png`;
                                    if (img.url.startsWith('data:')) {
                                      downloadDataUrl(img.url, filename);
                                      return;
                                    }
                                    void downloadViaFetch(img.url, filename).catch((err) =>
                                      toast(err?.message || 'Download failed.')
                                    );
                                  }}
                                >
                                  <Download className="w-3.5 h-3.5 mr-1.5 text-slate-600 group-hover/btn:text-purple-600 transition-colors" />
                                  <span className="text-slate-700 group-hover/btn:text-purple-600 transition-colors">Download</span>
                                </Button>
                                <Button
                                  size="sm"
                                  className="rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 shadow-md shadow-purple-500/20"
                                  onClick={() => {
                                    if (img.url.startsWith('data:')) {
                                      onUseInEditor(img.url);
                                      return;
                                    }
                                    void fetchUrlToDataUrl(img.url)
                                      .then((dataUrl) => onUseInEditor(dataUrl))
                                      .catch((err) => toast(err?.message || 'Failed to load image.'));
                                  }}
                                >
                                  Use in Editor
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div >
    </div >
  );
}
