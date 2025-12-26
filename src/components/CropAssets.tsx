import { useState } from 'react';
import { ArrowLeft, Check, Download, Grid3x3, Scissors } from 'lucide-react';

interface CropAssetsProps {
  imageUrl: string;
  onComplete: (images: string[]) => void;
  onBack: () => void;
}

export function CropAssets({ imageUrl, onComplete, onBack }: CropAssetsProps) {
  const [selectedCrops, setSelectedCrops] = useState<number[]>([1, 2, 3, 4]);
  const [isCropping, setIsCropping] = useState(false);
  const [savedAssets] = useState<string[]>([
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&h=800&fit=crop&q=100',
    'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=800&h=800&fit=crop&q=100',
    'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=800&h=800&fit=crop&q=100',
    'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&h=800&fit=crop&q=100',
  ]);

  const handleCropToggle = (index: number) => {
    setSelectedCrops((prev) =>
      prev.includes(index)
        ? prev.filter((i) => i !== index)
        : [...prev, index]
    );
  };

  const handleComplete = () => {
    setIsCropping(true);
    
    // Simulate high-quality cropping process
    setTimeout(() => {
      const croppedImages = selectedCrops.map((idx) => savedAssets[idx - 1]);
      setIsCropping(false);
      onComplete(croppedImages);
    }, 2000);
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Back to Preview</span>
          </button>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-slate-900 mb-2">Crop & Asset Management</h2>
              <p className="text-slate-600">Extract individual high-quality views from your multi-angle image</p>
            </div>
            <button
              onClick={handleComplete}
              disabled={selectedCrops.length === 0 || isCropping}
              className="px-6 py-3 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCropping ? (
                <>
                  <Scissors className="w-4 h-4 animate-pulse" />
                  <span>Cropping in HD...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>Continue to Editor ({selectedCrops.length} selected)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Quality Info Banner */}
        <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-500 flex items-center justify-center text-white">
              ✓
            </div>
            <div>
              <p className="text-sm text-slate-900">High-Quality Cropping Enabled</p>
              <p className="text-xs text-slate-600">Each view will be extracted at maximum resolution with no quality loss</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Crop Canvas */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
              <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Grid3x3 className="w-5 h-5 text-slate-600" />
                  <span className="text-sm text-slate-700">Crop Canvas</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 px-3 py-1 bg-slate-100 rounded-lg">
                    Original: 2048x2048
                  </span>
                  <button className="text-sm text-purple-600 hover:text-purple-700">
                    Auto-detect views
                  </button>
                </div>
              </div>
              
              <div className="relative bg-slate-900 aspect-[16/10] p-8">
                <div className="relative w-full h-full grid grid-cols-2 grid-rows-2 gap-4">
                  {[1, 2, 3, 4].map((index) => (
                    <button
                      key={index}
                      onClick={() => handleCropToggle(index)}
                      className={`relative overflow-hidden rounded-2xl border-4 transition-all group ${
                        selectedCrops.includes(index)
                          ? 'border-purple-500 shadow-xl shadow-purple-500/30'
                          : 'border-white/20 hover:border-white/40'
                      }`}
                    >
                      <img
                        src={savedAssets[index - 1]}
                        alt={`View ${index}`}
                        className="w-full h-full object-cover"
                      />
                      <div className={`absolute inset-0 transition-colors ${
                        selectedCrops.includes(index)
                          ? 'bg-purple-500/20'
                          : 'bg-black/40 group-hover:bg-black/30'
                      }`}>
                        <div className="absolute top-3 left-3 flex items-center gap-2">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                            selectedCrops.includes(index)
                              ? 'bg-purple-500 text-white shadow-lg'
                              : 'bg-white/80 text-slate-700'
                          }`}>
                            {selectedCrops.includes(index) ? '✓' : index}
                          </div>
                        </div>
                        <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 backdrop-blur-sm rounded-lg">
                          <span className="text-xs text-white">1024x1024</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 border-t border-slate-200 flex items-center justify-between">
                <p className="text-sm text-slate-600">
                  Click on each section to select/deselect views for editing
                </p>
                <button className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1">
                  <Download className="w-4 h-4" />
                  Export all crops
                </button>
              </div>
            </div>
          </div>

          {/* Asset Gallery Panel */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <h4 className="text-slate-900 mb-4">Selected Assets</h4>
              <div className="space-y-3">
                {selectedCrops.map((index) => (
                  <div
                    key={index}
                    className="group relative overflow-hidden rounded-xl border-2 border-slate-200 hover:border-purple-300 transition-all"
                  >
                    <div className="aspect-square bg-slate-100">
                      <img
                        src={savedAssets[index - 1]}
                        alt={`Asset ${index}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="absolute bottom-3 left-3 right-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white text-sm">View {index}</span>
                          <button className="w-8 h-8 bg-white/20 backdrop-blur-sm rounded-lg flex items-center justify-center hover:bg-white/30 transition-colors">
                            <Download className="w-4 h-4 text-white" />
                          </button>
                        </div>
                        <div className="text-xs text-white/80">High Quality • 1024x1024</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {selectedCrops.length === 0 && (
                <div className="text-center py-12">
                  <p className="text-slate-400 text-sm">No assets selected</p>
                </div>
              )}

              {/* Crop Settings */}
              <div className="mt-6 pt-6 border-t border-slate-200 space-y-4">
                <div>
                  <label className="block text-sm text-slate-700 mb-2">Output Quality</label>
                  <select className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm">
                    <option>Maximum Quality (No Compression)</option>
                    <option>High Quality (Minimal Compression)</option>
                    <option>Standard Quality</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-2">Output Format</label>
                  <select className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm">
                    <option>PNG (Lossless)</option>
                    <option>JPEG (High Quality)</option>
                    <option>WebP (Modern)</option>
                  </select>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-6 pt-6 border-t border-slate-200 space-y-2">
                <button className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors">
                  Download All Crops
                </button>
                <button className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors">
                  Save to Library
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}