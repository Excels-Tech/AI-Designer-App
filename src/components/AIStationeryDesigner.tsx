import { useMemo, useState } from 'react';
import { AspectRatio } from './ui/aspect-ratio';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { toast } from 'sonner';
import { Download, FileText, Loader2 } from 'lucide-react';
import { authFetch } from '../utils/auth';

type StationeryType = 'catalog' | 'letterhead' | 'visiting_card' | 'logo' | 'envelope' | 'brochure';

type StationeryResult = {
  id: string;
  type: StationeryType;
  label: string;
  url: string;
  width: number;
  height: number;
  createdAt: string;
  variant?: string | null;
};

const STATIONERY_ITEMS: Array<{
  id: StationeryType;
  label: string;
  width: number;
  height: number;
  notes: string;
}> = [
    { id: 'catalog', label: 'Catalog', width: 1536, height: 2048, notes: 'Print catalog cover / page layout' },
    { id: 'letterhead', label: 'Letterhead', width: 1440, height: 2048, notes: 'A4 vertical letterhead layout' },
    { id: 'visiting_card', label: 'Visiting Card', width: 1792, height: 1024, notes: 'Horizontal business card' },
    { id: 'logo', label: 'Logo', width: 1024, height: 1024, notes: 'Scalable mark + wordmark direction' },
    { id: 'envelope', label: 'Envelope', width: 1536, height: 1024, notes: 'Horizontal envelope layout' },
    { id: 'brochure', label: 'Brochure', width: 2048, height: 1440, notes: 'Wide brochure / flyer layout' },
  ];

function formatTypeLabel(type: StationeryType) {
  return STATIONERY_ITEMS.find((item) => item.id === type)?.label ?? type;
}

function toId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

export function AIStationeryDesigner() {
  const [selected, setSelected] = useState<Record<StationeryType, boolean>>({
    catalog: false,
    letterhead: false,
    visiting_card: false,
    logo: false,
    envelope: false,
    brochure: false,
  });
  const [brandName, setBrandName] = useState('');
  const [tagline, setTagline] = useState('');
  const [colors, setColors] = useState('');
  const [tone, setTone] = useState('');
  const [prompt, setPrompt] = useState('');
  const [results, setResults] = useState<StationeryResult[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingType, setGeneratingType] = useState<StationeryType | null>(null);

  const [sharedStyleDescription, setSharedStyleDescription] = useState<string | null>(null);
  const [customVariant, setCustomVariant] = useState('');
  const [showBrandStory, setShowBrandStory] = useState(false);

  const selectedTypes = useMemo(
    () => {
      const types = STATIONERY_ITEMS.map((item) => item.id).filter((id) => selected[id]);
      // Prioritize 'logo' as the first item to establish DNA
      return types.sort((a, b) => {
        if (a === 'logo') return -1;
        if (b === 'logo') return 1;
        return 0;
      });
    },
    [selected]
  );

  const toggleType = (type: StationeryType, checked: boolean) => {
    setSelected((prev) => ({ ...prev, [type]: checked }));
  };

  const generateSelected = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      toast('Please enter a prompt.');
      return;
    }
    if (!selectedTypes.length) {
      toast('Select at least one stationery item.');
      return;
    }

    setIsGenerating(true);
    // Clear the previous style DNA so this new batch establishes its own fresh consistent identity
    setSharedStyleDescription(null);
    let currentStyle: string | null = null;
    let dnaUrl: string | null = null; // Store the first image URL for vision-based anchoring

    try {
      for (const type of selectedTypes) {
        const item = STATIONERY_ITEMS.find((x) => x.id === type);
        if (!item) continue;
        setGeneratingType(type);

        try {
          const res = await authFetch('/api/image/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: trimmedPrompt,
              width: item.width,
              height: item.height,
              platform: 'stationery',
              designType: type,
              brandName: brandName.trim() || undefined,
              tagline: tagline.trim() || undefined,
              colors: colors.trim() || undefined,
              tone: tone.trim() || undefined,
              styleDescription: currentStyle || undefined,
              dnaImageUrl: dnaUrl || undefined, // Pass the pixel anchor
              variant: ((): string => {
                if (customVariant.trim()) return customVariant.trim();
                return 'random';
              })(),
            }),
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Generation failed.');

          const url = String(data?.images?.[0]?.url || '');
          if (!url) throw new Error('No image returned.');

          // Establish the "Visual DNA" from the first successful generation in this batch
          // 1. Capture the URL for Vision analysis in subsequent items
          if (!dnaUrl) {
            dnaUrl = url;
            console.log('[Stationery] DNA URL established for vision anchoring:', dnaUrl);

            // Critical: Give the server 1 second to ensure the image file is fully written and flushed
            // before the next request tries to read it for Vision analysis.
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          // 2. Fallback: Establish the text-based DNA anchor if vision didn't run or as a secondary signal
          if (!currentStyle && data.images?.[0]?.visualDNA) {
            currentStyle = data.images[0].visualDNA;
            setSharedStyleDescription(currentStyle);
            console.log('[Stationery] New batch DNA established:', currentStyle);
          }

          const returnedVariant = data.images?.[0]?.variant ?? null;

          const next: StationeryResult = {
            id: toId(),
            type,
            label: item.label,
            url,
            variant: returnedVariant,
            width: item.width,
            height: item.height,
            createdAt: new Date().toISOString(),
          };

          setResults((prev) => [next, ...prev]);
        } catch (err: any) {
          toast(`${formatTypeLabel(type)}: ${err?.message || 'Generation failed.'}`);
        }
      }

      toast('Done');
    } finally {
      setGeneratingType(null);
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="app-shimmer-sweep w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-slate-900">AI Stationery Designer</h2>
            <p className="text-slate-600 text-sm">Generate consistent stationery from one shared brand prompt.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <Card className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-slate-900">Stationery Items</h3>
                  <Badge
                    className="bg-gradient-to-r from-violet-500 to-purple-500 text-white border-0 shadow-sm"
                    variant="default"
                  >
                    {selectedTypes.length} selected
                  </Badge>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                  {STATIONERY_ITEMS.map((item) => {
                    const checked = !!selected[item.id];
                    return (
                      <label
                        key={item.id}
                        htmlFor={`stationery-${item.id}`}
                        className={`flex items-start gap-3 p-3 rounded-2xl border transition-all cursor-pointer select-none ${checked
                          ? 'border-purple-200 bg-purple-50/60 shadow-sm'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                          }`}
                      >
                        <Checkbox
                          id={`stationery-${item.id}`}
                          checked={checked}
                          onCheckedChange={(v: boolean | 'indeterminate') => toggleType(item.id, v === true)}
                          className="mt-0.5 data-[state=checked]:bg-purple-600 data-[state=checked]:border-purple-600"
                        />
                        <div className="min-w-0">
                          <div className="text-sm text-slate-900">{item.label}</div>
                          <div className="text-xs text-slate-500">{item.notes}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-slate-900">Brand Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-700">Brand Name</Label>
                    <Input className="rounded-xl" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-700">Tagline</Label>
                    <Input className="rounded-xl" value={tagline} onChange={(e) => setTagline(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-700">Colors</Label>
                    <Input
                      className="rounded-xl"
                      placeholder="e.g. violet, charcoal, off-white"
                      value={colors}
                      onChange={(e) => setColors(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-700">Tone</Label>
                    <Input
                      className="rounded-xl"
                      placeholder="e.g. modern, minimal, premium"
                      value={tone}
                      onChange={(e) => setTone(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => setShowBrandStory(!showBrandStory)}
                  className="text-slate-700 text-sm font-medium hover:text-slate-900 flex items-center gap-2"
                >
                  <span>{showBrandStory ? '▼' : '▶'}</span>
                  Brand Story (optional)
                </button>
                {showBrandStory && (
                  <>
                    <Textarea
                      className="rounded-2xl min-h-[120px]"
                      placeholder="Add additional brand story, vision, or creative direction..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                    <p className="text-xs text-slate-500">
                      This will enhance the stationery design with additional context.
                    </p>
                  </>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-slate-700">Custom (optional)</Label>
                <Input
                  className="rounded-xl"
                  placeholder="Custom variant description"
                  value={customVariant}
                  onChange={(e) => setCustomVariant(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-3">
                {sharedStyleDescription && (
                  <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-100 rounded-2xl">
                    <Badge className="bg-blue-500 text-white border-0 h-6">Batch Consistency Active</Badge>
                    <span className="text-xs text-blue-600">
                      All items in this set will share the same logo and visual style.
                    </span>
                  </div>
                )}

                <Button
                  className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-purple-500/30 hover:opacity-95"
                  onClick={generateSelected}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating{generatingType ? `: ${formatTypeLabel(generatingType)}` : '...'}
                    </>
                  ) : (
                    'Generate Selected'
                  )}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-3 bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-slate-900">Results</h3>
                <Badge variant="secondary" className="rounded-xl">
                  {results.length} total
                </Badge>
              </div>

              {!results.length ? (
                <div className="border border-dashed border-slate-200 rounded-2xl p-10 text-center bg-slate-50/40">
                  <p className="text-slate-600">No designs yet.</p>
                  <p className="text-sm text-slate-500 mt-1">
                    Select stationery items on the left and generate to see previews here.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {results.map((result) => (
                    <Card
                      key={result.id}
                      className="rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-slate-50/60">
                        <Badge className="bg-gradient-to-r from-violet-500 to-purple-500 text-white border-0">
                          {result.label}
                        </Badge>
                        <div className="flex items-center gap-2">
                          {result.variant ? (
                            <div className="text-xs text-slate-500 mr-2">Variant: {result.variant}</div>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-xl"
                            asChild
                          >
                            <a href={result.url} target="_blank" rel="noreferrer">
                              <Download className="w-4 h-4" />
                              Open
                            </a>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-xl text-purple-700 hover:text-purple-800 hover:bg-purple-50"
                            onClick={async () => {
                              try {
                                await downloadViaFetch(result.url, `${result.type}-${Date.now()}.png`);
                              } catch (err: any) {
                                toast(err?.message || 'Download failed.');
                              }
                            }}
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="p-4">
                        <AspectRatio ratio={result.width / result.height}>
                          <img
                            src={result.url}
                            alt={`${result.label} preview`}
                            className="w-full h-full object-cover rounded-xl border border-slate-200"
                            loading="lazy"
                          />
                        </AspectRatio>
                        <div className="mt-3 text-xs text-slate-500">
                          {result.width}×{result.height}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
