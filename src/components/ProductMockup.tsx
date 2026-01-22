import { useEffect, useMemo, useState } from 'react';
import { Package, Eye, Download, Video, Grid2x2 } from 'lucide-react';
import { authFetch } from '../utils/auth';

interface ProductMockupProps {
  designUrl: string | null;
  onCreateVideo: () => void;
}

const products = [
  { id: 'tshirt', label: 'T-Shirt', icon: '👕' },
  { id: 'hoodie', label: 'Hoodie', icon: '🧥' },
  { id: 'bag', label: 'Tote Bag', icon: '👜' },
  { id: 'mug', label: 'Mug', icon: '☕' },
];

function isPngDataUrl(value: string) {
  return /^data:image\/png;base64,/i.test(value);
}

async function anyImageToPngDataUrl(src: string): Promise<string> {
  const trimmed = String(src || '').trim();
  if (!trimmed) throw new Error('Missing image source.');
  if (isPngDataUrl(trimmed)) return trimmed;

  if (trimmed.startsWith('data:image/')) {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load image.'));
      el.src = trimmed;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width || 1;
    canvas.height = img.naturalHeight || img.height || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available.');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  const res = await fetch(trimmed);
  if (!res.ok) throw new Error('Failed to fetch image.');
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
  return await anyImageToPngDataUrl(dataUrl);
}

export function ProductMockup({ designUrl, onCreateVideo }: ProductMockupProps) {
  const [selectedProduct, setSelectedProduct] = useState('tshirt');
  const [viewMode, setViewMode] = useState<'flat' | 'realistic'>('realistic');

  const mockupUrl = designUrl || 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&h=800&fit=crop';

  const selectedProductLabel = useMemo(
    () => products.find((p) => p.id === selectedProduct)?.label ?? 'product',
    [selectedProduct]
  );

  const [aiRenderedUrl, setAiRenderedUrl] = useState<string | null>(null);
  const [aiRenderError, setAiRenderError] = useState<string | null>(null);
  const [aiRendering, setAiRendering] = useState(false);
  const [lastRenderedInput, setLastRenderedInput] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      if (viewMode !== 'realistic') return;
      if (!designUrl) return;
      if (lastRenderedInput === designUrl && aiRenderedUrl) return;

      setAiRendering(true);
      setAiRenderError(null);
      setAiRenderedUrl(null);

      try {
        const imageDataUrl = await anyImageToPngDataUrl(designUrl);
        const resp = await authFetch('/api/realistic/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageDataUrl,
            prompt: `Render this design printed onto a realistic ${selectedProductLabel}. Keep the logo/watermark exactly the same; make it look like real ink/print on the material (not a floating overlay layer).`,
          }),
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(payload.error || 'Realistic render failed.');
        const out = typeof payload?.imageDataUrl === 'string' ? payload.imageDataUrl.trim() : '';
        if (!out) throw new Error('Realistic render returned no image.');
        if (!alive) return;
        setAiRenderedUrl(out);
        setLastRenderedInput(designUrl);
      } catch (err: any) {
        if (!alive) return;
        setAiRenderError(err?.message || 'Realistic render failed.');
      } finally {
        if (!alive) return;
        setAiRendering(false);
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [viewMode, designUrl, selectedProductLabel, lastRenderedInput, aiRenderedUrl]);

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center">
                  <Package className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-slate-900">Product Mockup & Preview</h2>
              </div>
              <p className="text-slate-600">See your design on real products</p>
            </div>
            <div className="flex items-center gap-3">
              <button className="px-4 py-2 bg-white border border-slate-200 rounded-xl hover:shadow-lg transition-all flex items-center gap-2 text-slate-700">
                <Download className="w-4 h-4" />
                <span className="text-sm">Download</span>
              </button>
              <button
                onClick={onCreateVideo}
                className="px-6 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2"
              >
                <Video className="w-4 h-4" />
                <span className="text-sm">Create Video</span>
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Product Selection */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <h4 className="text-slate-900 mb-4">Select Product</h4>
              <div className="space-y-2">
                {products.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => setSelectedProduct(product.id)}
                    className={`w-full p-4 rounded-xl border-2 transition-all text-left flex items-center gap-3 ${
                      selectedProduct === product.id
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="text-2xl">{product.icon}</span>
                    <span className="text-slate-900">{product.label}</span>
                  </button>
                ))}
              </div>

              {/* View Toggle */}
              <div className="mt-6 pt-6 border-t border-slate-200">
                <h4 className="text-slate-900 mb-4">View Mode</h4>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setViewMode('flat')}
                    className={`px-4 py-3 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                      viewMode === 'flat'
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Grid2x2 className="w-5 h-5 text-slate-600" />
                    <span className="text-xs text-slate-700">Flat Design</span>
                  </button>
                  <button
                    onClick={() => setViewMode('realistic')}
                    className={`px-4 py-3 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                      viewMode === 'realistic'
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Eye className="w-5 h-5 text-slate-600" />
                    <span className="text-xs text-slate-700">Realistic</span>
                  </button>
                </div>
              </div>

              {/* Preview Options */}
              <div className="mt-6 pt-6 border-t border-slate-200 space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-slate-300" />
                  <span className="text-sm text-slate-700">Show shadows</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-slate-300" />
                  <span className="text-sm text-slate-700">Realistic lighting</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-slate-300" />
                  <span className="text-sm text-slate-700">Fabric texture</span>
                </label>
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
              <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-slate-600" />
                  <span className="text-sm text-slate-700">
                    {viewMode === 'flat' ? 'Flat Design View' : 'Realistic Product Preview'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs text-slate-700 transition-colors">
                    Front
                  </button>
                  <button className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs text-slate-700 transition-colors">
                    Back
                  </button>
                  <button className="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs text-slate-700 transition-colors">
                    Side
                  </button>
                </div>
              </div>

              <div className="aspect-[4/3] bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center p-12">
                {viewMode === 'flat' ? (
                  <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8">
                    <img
                      src={mockupUrl}
                      alt="Flat design"
                      className="w-full h-auto rounded-xl"
                    />
                  </div>
                ) : (
                  <div className="w-full max-w-2xl">
                    {aiRendering ? (
                      <div className="w-full bg-white rounded-2xl shadow-2xl p-10 text-center">
                        <p className="text-sm text-slate-700">Rendering realistic preview…</p>
                        <p className="text-xs text-slate-500 mt-2">Embedding your design into the product photo (no overlay layers).</p>
                      </div>
                    ) : aiRenderedUrl ? (
                      <img src={aiRenderedUrl} alt="Realistic product render" className="w-full h-auto rounded-2xl shadow-2xl" />
                    ) : (
                      <div className="relative">
                        <img
                          src="https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&h=700&fit=crop"
                          alt="Product mockup"
                          className="w-96 h-auto rounded-2xl shadow-2xl mx-auto"
                        />
                        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-48 h-48 opacity-90">
                          <img src={mockupUrl} alt="Design overlay" className="w-full h-full object-contain mix-blend-multiply" />
                        </div>
                        {aiRenderError && (
                          <div className="mt-4 text-center">
                            <p className="text-xs text-red-700">{aiRenderError}</p>
                            <button
                              type="button"
                              onClick={() => {
                                setLastRenderedInput(null);
                                setAiRenderedUrl(null);
                                setAiRenderError(null);
                              }}
                              className="mt-2 px-3 py-1 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 hover:bg-slate-50"
                            >
                              Retry realistic render
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="p-6 border-t border-slate-200 bg-slate-50">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h4 className="text-slate-900">Preview Settings</h4>
                    <p className="text-sm text-slate-600">High-quality render • 4K resolution</p>
                  </div>
                  <button className="px-4 py-2 bg-purple-500 text-white rounded-xl hover:bg-purple-600 transition-colors text-sm">
                    Export Preview
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
