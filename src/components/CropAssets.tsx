import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Download, Grid3x3, Scissors } from 'lucide-react';
import JSZip from 'jszip';
import { getCellRects, getLayout } from '../utils/multiViewLayout';
import { createDesign as createDesignApi } from '../services/designApi';

interface CropAssetsProps {
  result: {
    combinedImage: string;
    views: { view: string; image: string }[];
  };
  request: any;
  onDesignSaved?: (designId: string) => void;
  onComplete: (images: string[]) => void;
  onBack: () => void;
}

export function CropAssets({ result, request, onDesignSaved, onComplete, onBack }: CropAssetsProps) {
  const layout = useMemo(() => getLayout(result.views.length), [result.views.length]);
  const totalSlots = layout.cols * layout.rows;
  const [selectedCrops, setSelectedCrops] = useState<number[]>(
    Array.from({ length: result.views.length }, (_, i) => i + 1)
  );
  const [isCropping, setIsCropping] = useState(false);
  const [savedAssets, setSavedAssets] = useState<string[]>(Array(totalSlots).fill(''));
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpg' | 'webp'>('png');
  const [outputQuality, setOutputQuality] = useState<'max' | 'high' | 'medium'>('max');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [toast, setToast] = useState<string | null>(null);

  const handleCropToggle = (index: number) => {
    const isUnused = index > result.views.length;
    if (isUnused) return;
    setSelectedCrops((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  const handleComplete = () => {
    setIsCropping(true);
    const croppedImages = selectedCrops.map((idx) => savedAssets[idx - 1]).filter(Boolean);
    setIsCropping(false);
    onComplete(croppedImages);
  };

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      setImageSize({ width, height });
      const rects = getCellRects(width, height, layout.cols, layout.rows);
      const crops: string[] = [];
      rects.forEach((rect) => {
        const canvas = document.createElement('canvas');
        canvas.width = rect.w;
        canvas.height = rect.h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
          crops.push(canvas.toDataURL('image/png'));
        }
      });
      setSavedAssets(crops);
    };
    img.src = result.combinedImage;
  }, [layout.cols, layout.rows, result.combinedImage]);

  const qualityToFloat = (q: 'max' | 'high' | 'medium') => {
    if (q === 'high') return 0.92;
    if (q === 'medium') return 0.8;
    return 1;
  };

  const convertDataUrl = (dataUrl: string, format: 'png' | 'jpg' | 'webp', quality: 'max' | 'high' | 'medium') =>
    new Promise<string>((resolve) => {
      if (format === 'png') return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const mime = format === 'jpg' ? 'image/jpeg' : 'image/webp';
          resolve(canvas.toDataURL(mime, qualityToFloat(quality)));
        } else {
          resolve(dataUrl);
        }
      };
      img.src = dataUrl;
    });

  const handleDownloadAll = async () => {
    const zip = new JSZip();
    const title = (request?.prompt || 'design').split(' ').slice(0, 6).join('_') || 'design';
    const resolution = request?.resolution || 'img';
    const format = outputFormat;
    const quality = outputQuality;
    const slots = result.views.length;

    for (let i = 0; i < slots; i++) {
      const view = request?.views?.[i] || result.views[i]?.view || `view${i + 1}`;
      const dataUrl = await convertDataUrl(savedAssets[i], format, quality);
      const base64 = dataUrl.split(',')[1] || '';
      zip.file(`${title}_${view}_${resolution}.${format === 'jpg' ? 'jpg' : format}`, base64, { base64: true });
    }

    // include combined image
    const combined = await convertDataUrl(result.combinedImage, format, quality);
    zip.file(`${title}_combined_${resolution}.${format === 'jpg' ? 'jpg' : format}`, combined.split(',')[1] || '', {
      base64: true,
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'my-design-crops.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleSaveLibrary = async () => {
    if (!result || !request || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const format = outputFormat;
      const quality = outputQuality;
      const crops = result.views.map((v, idx) => ({
        view: v.view,
        dataUrl: savedAssets[idx],
      }));
      const payload = {
        title: (request.prompt || 'Untitled').split(' ').slice(0, 6).join(' ') || 'Untitled Design',
        prompt: request.prompt,
        style: request.style,
        resolution: request.resolution,
        format,
        quality,
        combinedImage: result.combinedImage,
        views: crops.map((c) => ({ view: c.view, image: c.dataUrl })),
      };
      const design = await createDesignApi(payload);
      if (onDesignSaved) onDesignSaved(design.designId);
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
                    Original: {imageSize ? `${imageSize.width}x${imageSize.height}` : '...'}
                  </span>
                </div>
              </div>
              
              <div className="relative bg-slate-900 aspect-[16/10] p-8">
                <div
                  className="relative w-full h-full gap-4"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: totalSlots }, (_, i) => i + 1).map((index) => {
                    const isUnused = index > result.views.length;
                    const thumb = savedAssets[index - 1];
                    return (
                      <button
                        key={index}
                        onClick={() => handleCropToggle(index)}
                        className={`relative overflow-hidden rounded-2xl border-4 transition-all group ${
                          selectedCrops.includes(index)
                            ? 'border-purple-500 shadow-xl shadow-purple-500/30'
                            : 'border-white/20 hover:border-white/40'
                        } ${isUnused ? 'opacity-50 cursor-not-allowed' : ''}`}
                        disabled={isUnused}
                      >
                        <img
                          src={thumb || result.combinedImage}
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
                            <span className="text-xs text-white">
                              {thumb && imageSize
                                ? `${Math.round(imageSize.width / layout.cols)}x${Math.round(
                                    imageSize.height / layout.rows
                                  )}`
                                : 'pending'}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
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
                        <div className="text-xs text-white/80">High Quality • {imageSize ? `${Math.round(imageSize.width / layout.cols)}x${Math.round(imageSize.height / layout.rows)}` : '...'} </div>
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
                  <select
                    value={outputQuality}
                    onChange={(e) => setOutputQuality(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  >
                    <option value="max">Maximum Quality (No Compression)</option>
                    <option value="high">High Quality (Minimal Compression)</option>
                    <option value="medium">Standard Quality</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-slate-700 mb-2">Output Format</label>
                  <select
                    value={outputFormat}
                    onChange={(e) => setOutputFormat(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  >
                    <option value="png">PNG (Lossless)</option>
                    <option value="jpg">JPEG (High Quality)</option>
                    <option value="webp">WebP (Modern)</option>
                  </select>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-6 pt-6 border-t border-slate-200 space-y-2">
                <button
                  onClick={handleDownloadAll}
                  className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors"
                >
                  Download All Crops
                </button>
                <button
                  onClick={handleSaveLibrary}
                  disabled={saveState === 'saving'}
                  className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved ✓' : 'Save to Library'}
                </button>
              </div>
            </div>
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
