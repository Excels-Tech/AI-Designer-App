import { useState } from 'react';
import { Package, Eye, Download, Video, Grid2x2 } from 'lucide-react';

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

export function ProductMockup({ designUrl, onCreateVideo }: ProductMockupProps) {
  const [selectedProduct, setSelectedProduct] = useState('tshirt');
  const [viewMode, setViewMode] = useState<'flat' | 'realistic'>('realistic');

  const mockupUrl = designUrl || 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&h=800&fit=crop';

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
                  <div className="relative">
                    {/* T-shirt mockup */}
                    <img
                      src="https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&h=700&fit=crop"
                      alt="Product mockup"
                      className="w-96 h-auto rounded-2xl shadow-2xl"
                    />
                    {/* Design overlay */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-48 h-48 opacity-90">
                      <img
                        src={mockupUrl}
                        alt="Design overlay"
                        className="w-full h-full object-contain mix-blend-multiply"
                      />
                    </div>
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
