import { useState, useRef, useEffect } from 'react';
import { 
  Layers, 
  Plus, 
  Trash2, 
  Eye, 
  EyeOff, 
  Lock, 
  Unlock, 
  RotateCw, 
  Upload,
  Undo,
  Redo,
  Check,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sparkles,
  Scissors,
  MousePointer,
  Image as ImageIcon,
  Wand2,
  Loader2
} from 'lucide-react';
import { tintCutout } from '../utils/recolor';
import { renderComposite } from '../utils/composite';

interface DesignEditorProps {
  baseImages: string[];
  onComplete: (designUrl: string) => void;
}

interface Layer {
  id: string;
  name: string;
  type: 'image' | 'text' | 'logo' | 'auto-extracted' | 'uploaded' | 'rendered';
  visible: boolean;
  locked: boolean;
  imageUrl?: string;
  originalCutoutUrl?: string;
  maskUrl?: string;
  color?: string;
  isColorChangeable?: boolean;
  position?: { x: number; y: number };
  scale?: number;
  opacity?: number;
  blendMode?: GlobalCompositeOperation;
}

function toDataUrl(inputUrlOrDataUrl: string): Promise<string> {
  if (inputUrlOrDataUrl.startsWith('data:')) {
    return Promise.resolve(inputUrlOrDataUrl);
  }

  return fetch(inputUrlOrDataUrl, { mode: 'cors' })
    .then((res) => {
      if (!res.ok) {
        throw new Error('Failed to fetch image.');
      }
      return res.blob();
    })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read image data.'));
      reader.readAsDataURL(blob);
    }));
}

export function DesignEditor({ baseImages, onComplete }: DesignEditorProps) {
  const [layers, setLayers] = useState<Layer[]>([
    { id: '1', name: 'Base Image', type: 'image', visible: true, locked: false, imageUrl: baseImages[0] || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&h=800&fit=crop' },
  ]);
  const [selectedLayer, setSelectedLayer] = useState('1');
  const [selectedColor, setSelectedColor] = useState('#8B5CF6');
  const [isExtracting, setIsExtracting] = useState(false);
  const [showLayerExtractor, setShowLayerExtractor] = useState(true);
  const [isGeneratingRealistic, setIsGeneratingRealistic] = useState(false);
  const [realisticPreview, setRealisticPreview] = useState<string | null>(null);
  const [showRealisticPreview, setShowRealisticPreview] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [showLayerMap, setShowLayerMap] = useState(false);
  const [hoveredLayer, setHoveredLayer] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [realisticPrompt, setRealisticPrompt] = useState('');
  const [compositePreview, setCompositePreview] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const selectedLayerData = layers.find((l) => l.id === selectedLayer);

  useEffect(() => {
    if (selectedLayerData?.color) {
      setSelectedColor(selectedLayerData.color);
    }
  }, [selectedLayerData?.id, selectedLayerData?.color]);

  useEffect(() => {
    if (!layers.length) return;
    const handle = window.setTimeout(() => {
      renderComposite(layers)
        .then(setCompositePreview)
        .catch(() => {});
    }, 150);
    return () => window.clearTimeout(handle);
  }, [layers]);

  // Upload image from PC
  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const imageUrl = e.target?.result as string;
        const newLayer: Layer = {
          id: Date.now().toString(),
          name: file.name,
          type: 'uploaded',
          visible: true,
          locked: false,
          imageUrl,
          position: { x: 50, y: 50 },
          scale: 1,
        };
        setLayers([...layers, newLayer]);
        setSelectedLayer(newLayer.id);
        setShowLayerExtractor(true);
      };
      reader.readAsDataURL(file);
    }
  };

  // Upload logo/design from PC
  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const imageUrl = e.target?.result as string;
        const logoLayer: Layer = {
          id: Date.now().toString(),
          name: `Logo - ${file.name}`,
          type: 'logo',
          visible: true,
          locked: false,
          imageUrl,
          position: { x: 50, y: 50 },
          scale: 0.3,
        };
        setLayers([...layers, logoLayer]);
        setSelectedLayer(logoLayer.id);
      };
      reader.readAsDataURL(file);
    }
  };

  // Auto-extract layers from image with color-based detection
  const handleAutoExtractLayers = async () => {
    setIsExtracting(true);
    setShowLayerExtractor(false);
    setErrorMessage(null);

    const sourceLayer =
      selectedLayerData && (selectedLayerData.type === 'uploaded' || selectedLayerData.type === 'logo')
        ? selectedLayerData
        : layers.find((layer) => layer.type === 'image') ?? layers[0];

    if (!sourceLayer?.imageUrl) {
      setErrorMessage('Please select a layer with an image to analyze.');
      setIsExtracting(false);
      setShowLayerExtractor(true);
      return;
    }

    try {
      const imageDataUrl = await toDataUrl(sourceLayer.imageUrl);
      const response = await fetch('/api/sam2/color-layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, num_layers: 4 }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Layer detection failed. Try a simpler image or increase contrast.');
      }

      const extractedLayers: Layer[] = (data.layers || []).map((layer: any) => ({
        id: layer.id,
        name: layer.label,
        type: 'auto-extracted',
        visible: true,
        locked: false,
        imageUrl: layer.cutoutPng,
        originalCutoutUrl: layer.cutoutPng,
        maskUrl: layer.maskPng,
        color: layer.suggestedColor,
        isColorChangeable: true,
        opacity: 1,
      }));

      if (!extractedLayers.length) {
        throw new Error('Layer detection failed. Try a simpler image or increase contrast.');
      }

      setLayers((prev) => {
        const baseIndex = prev.findIndex((layer) => layer.type === 'image');
        const insertAt = baseIndex >= 0 ? baseIndex + 1 : 1;
        return [...prev.slice(0, insertAt), ...extractedLayers, ...prev.slice(insertAt)];
      });
      setIsExtracting(false);
      setSelectedLayer(extractedLayers[0].id);
      setShowLayerMap(true);
      setSelectionMode(true);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'Layer detection failed.';
      if (message.toLowerCase().includes('cors') || message.toLowerCase().includes('fetch')) {
        setErrorMessage('Cannot access remote image due to CORS. Please upload the image file instead.');
      } else {
        setErrorMessage(message);
      }
      setIsExtracting(false);
      setShowLayerExtractor(true);
    }
  };

  // Generate realistic preview from edited layers
  const handleGenerateRealistic = async () => {
    setIsGeneratingRealistic(true);
    setErrorMessage(null);

    try {
      const composite = await renderComposite(layers);
      setCompositePreview(composite);

      const response = await fetch('/api/realistic/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: composite, prompt: realisticPrompt }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Realistic render failed.');
      }

      setRealisticPreview(data.imageDataUrl);
      setIsGeneratingRealistic(false);
      setShowRealisticPreview(true);
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Realistic render failed.');
      setIsGeneratingRealistic(false);
    }
  };

  const toggleLayerVisibility = (id: string) => {
    setLayers(layers.map((layer) =>
      layer.id === id ? { ...layer, visible: !layer.visible } : layer
    ));
  };

  const toggleLayerLock = (id: string) => {
    setLayers(layers.map((layer) =>
      layer.id === id ? { ...layer, locked: !layer.locked } : layer
    ));
  };

  const deleteLayer = (id: string) => {
    if (layers.length === 1) return;
    setLayers(layers.filter((layer) => layer.id !== id));
    if (selectedLayer === id) {
      setSelectedLayer(layers[0].id);
    }
  };

  const updateLayerColor = async (color: string) => {
    setSelectedColor(color);
    const currentLayer = layers.find((layer) => layer.id === selectedLayer);
    if (currentLayer?.type === 'auto-extracted' && currentLayer.originalCutoutUrl) {
      try {
        const tinted = await tintCutout(currentLayer.originalCutoutUrl, color);
        setLayers((prev) =>
          prev.map((layer) =>
            layer.id === selectedLayer ? { ...layer, color, imageUrl: tinted } : layer
          )
        );
      } catch (err) {
        console.error(err);
        setErrorMessage('Failed to apply color. Please try again.');
        setLayers((prev) =>
          prev.map((layer) => (layer.id === selectedLayer ? { ...layer, color } : layer))
        );
      }
    } else {
      setLayers((prev) => prev.map((layer) => (layer.id === selectedLayer ? { ...layer, color } : layer)));
    }
  };

  return (
    <div className="h-screen flex bg-slate-50">
      {/* Left Panel - Layers */}
      <div className="w-80 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
        <div className="p-4 border-b border-slate-200">
          <h4 className="text-slate-900 flex items-center gap-2 mb-3">
            <Layers className="w-5 h-5" />
            Layers ({layers.length})
          </h4>
          
          {/* Upload Image Button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-500 text-white rounded-xl hover:shadow-lg transition-all flex items-center justify-center gap-2 text-sm"
          >
            <Upload className="w-4 h-4" />
            Upload Image from PC
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
          />
        </div>

        {/* Layer Extractor Banner */}
        {showLayerExtractor && layers.some(l => l.type === 'uploaded' || l.type === 'image') && (
          <div className="m-4 p-4 bg-gradient-to-br from-violet-50 to-purple-50 border-2 border-purple-200 rounded-2xl">
            <div className="flex items-start gap-3 mb-3">
              <Sparkles className="w-5 h-5 text-purple-600 flex-shrink-0 mt-0.5" />
              <div>
                <h5 className="text-slate-900 text-sm mb-1">AI Color Detection</h5>
                <p className="text-xs text-slate-600">
                  Automatically detect different colored parts and create separate editable layers
                </p>
              </div>
            </div>
            <button
              onClick={handleAutoExtractLayers}
              disabled={isExtracting}
              className="w-full px-4 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-lg transition-all text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Detecting colors...</span>
                </>
              ) : (
                <>
                  <Scissors className="w-4 h-4" />
                  <span>Detect Color Layers</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Layer Selection Mode Toggle */}
        <div className="px-4 pb-2">
          <button
            onClick={() => setSelectionMode(!selectionMode)}
            className={`w-full px-4 py-2 rounded-xl text-sm flex items-center justify-center gap-2 transition-all ${
              selectionMode
                ? 'bg-purple-500 text-white shadow-lg'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <MousePointer className="w-4 h-4" />
            {selectionMode ? 'Selection Mode ON' : 'Click to Select Layer'}
          </button>
        </div>

        {/* Layer Map Toggle */}
        {layers.some(l => l.type === 'auto-extracted') && (
          <div className="px-4 pb-2">
            <button
              onClick={() => setShowLayerMap(!showLayerMap)}
              className={`w-full px-4 py-2 rounded-xl text-sm flex items-center justify-center gap-2 transition-all ${
                showLayerMap
                  ? 'bg-green-500 text-white shadow-lg'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Layers className="w-4 h-4" />
              {showLayerMap ? 'Layer Map ON' : 'Show Layer Map'}
            </button>
          </div>
        )}
        
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {layers.map((layer) => (
            <div
              key={layer.id}
              onClick={() => !layer.locked && setSelectedLayer(layer.id)}
              onMouseEnter={() => setHoveredLayer(layer.id)}
              onMouseLeave={() => setHoveredLayer(null)}
              className={`p-3 rounded-xl border-2 transition-all cursor-pointer ${
                selectedLayer === layer.id
                  ? 'border-purple-500 bg-purple-50 shadow-lg'
                  : hoveredLayer === layer.id
                  ? 'border-purple-300 bg-purple-25'
                  : 'border-slate-200 hover:border-slate-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm flex-1 text-slate-900">{layer.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayerVisibility(layer.id);
                  }}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {layer.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayerLock(layer.id);
                  }}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {layer.locked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLayer(layer.id);
                  }}
                  className="text-slate-400 hover:text-red-600"
                  disabled={layers.length === 1}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {layer.imageUrl && (
                <div className="w-full h-16 bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                  <img src={layer.imageUrl} alt={layer.name} className="w-full h-full object-cover" />
                </div>
              )}
              {layer.isColorChangeable && (
                <div className="mt-2 flex items-center gap-2">
                  <div 
                    className="w-4 h-4 rounded border-2 border-white shadow-sm"
                    style={{ backgroundColor: layer.color }}
                  />
                  <span className="text-xs text-purple-600 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Color editable
                  </span>
                </div>
              )}
              {(layer.type === 'logo' || layer.type === 'uploaded') && (
                <div className="mt-2 text-xs text-slate-500">
                  Custom upload
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Center - Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Top Bar */}
        <div className="bg-white border-b border-slate-200 p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors">
              <Undo className="w-5 h-5 text-slate-600" />
            </button>
            <button className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors">
              <Redo className="w-5 h-5 text-slate-600" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Optional prompt for realism"
              value={realisticPrompt}
              onChange={(e) => setRealisticPrompt(e.target.value)}
              className="hidden lg:block px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white text-slate-700 w-64"
            />
            <button
              onClick={handleGenerateRealistic}
              disabled={isGeneratingRealistic || layers.length < 2}
              className="px-4 py-2 bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded-xl hover:shadow-xl transition-all text-sm disabled:opacity-50 flex items-center gap-2"
            >
              {isGeneratingRealistic ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Rendering...</span>
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  <span>Generate Realistic</span>
                </>
              )}
            </button>
            <button className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors">
              Save Version
            </button>
            <button
              onClick={() => onComplete(realisticPreview || selectedLayerData?.imageUrl || baseImages[0])}
              className="px-6 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              <span>Continue to Product</span>
            </button>
          </div>
        </div>

        {errorMessage && (
          <div className="mx-8 mt-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
            {errorMessage}
          </div>
        )}

        {/* Canvas */}
        <div className="flex-1 p-8 overflow-auto flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
          {showRealisticPreview && realisticPreview ? (
            // Realistic Preview Mode
            <div className="space-y-6 max-w-4xl">
              <div className="text-center">
                <h3 className="text-slate-900 mb-2">Realistic Preview Generated</h3>
                <p className="text-slate-600 mb-4">Your edited design has been converted to a photorealistic image</p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={() => setShowRealisticPreview(false)}
                    className="text-sm text-purple-600 hover:text-purple-700"
                  >
                    Back to layer editor
                  </button>
                  {realisticPreview && (
                    <>
                      <button
                        onClick={() => {
                          setLayers((prev) =>
                            prev.map((layer) =>
                              layer.type === 'image' ? { ...layer, imageUrl: realisticPreview } : layer
                            )
                          );
                          setShowRealisticPreview(false);
                        }}
                        className="px-3 py-2 bg-purple-600 text-white rounded-lg text-xs"
                      >
                        Use as Base Image
                      </button>
                      <button
                        onClick={() => {
                          const newLayer: Layer = {
                            id: Date.now().toString(),
                            name: 'Realistic Render',
                            type: 'rendered',
                            visible: true,
                            locked: false,
                            imageUrl: realisticPreview,
                          };
                          setLayers((prev) => [...prev, newLayer]);
                          setSelectedLayer(newLayer.id);
                          setShowRealisticPreview(false);
                        }}
                        className="px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs"
                      >
                        Add as New Layer
                      </button>
                    </>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-6">
                {/* Before */}
                <div>
                  <p className="text-sm text-slate-600 mb-3 text-center">Before (Layers)</p>
                  <div className="relative bg-white rounded-3xl shadow-2xl p-8" style={{ width: '400px', height: '400px' }}>
                    <div className="relative w-full h-full bg-slate-50 rounded-2xl overflow-hidden">
                      {compositePreview ? (
                        <img src={compositePreview} alt="Composite preview" className="w-full h-full object-cover" />
                      ) : (
                        layers.filter(l => l.visible).slice(0, 3).map((layer) => (
                          <div key={layer.id} className="absolute inset-0">
                            {layer.imageUrl && (
                              <img
                                src={layer.imageUrl}
                                alt={layer.name}
                                className="w-full h-full object-cover opacity-50"
                              />
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* After */}
                <div>
                  <p className="text-sm text-slate-600 mb-3 text-center">After (Realistic)</p>
                  <div className="relative bg-white rounded-3xl shadow-2xl p-8" style={{ width: '400px', height: '400px' }}>
                    <div className="relative w-full h-full bg-slate-50 rounded-2xl overflow-hidden">
                      <img
                        src={realisticPreview}
                        alt="Realistic preview"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // Layer Editor Mode
            <div className="relative bg-white rounded-3xl shadow-2xl p-8" style={{ width: '600px', height: '600px' }}>
              <div className="relative w-full h-full bg-slate-50 rounded-2xl overflow-hidden">
                {/* Composite Preview */}
                {compositePreview ? (
                  <img
                    src={compositePreview}
                    alt="Composite preview"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : (
                  layers[0]?.imageUrl && (
                    <img
                      src={layers[0].imageUrl}
                      alt="Base layer"
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  )
                )}

                {/* Color-Coded Layer Map Overlay */}
                {showLayerMap && (
                  <div className="absolute inset-0 z-20">
                    {layers.filter(l => l.type === 'auto-extracted' && l.visible && l.maskUrl).map((layer, index) => {
                      const layerColors = [
                        'rgba(239, 68, 68, 0.4)',   // Red
                        'rgba(59, 130, 246, 0.4)',  // Blue
                        'rgba(16, 185, 129, 0.4)',  // Green
                        'rgba(245, 158, 11, 0.4)',  // Orange
                        'rgba(139, 92, 246, 0.4)',  // Purple
                      ];

                      return (
                        <div
                          key={`map-${layer.id}`}
                          className="absolute inset-0 transition-all"
                          style={{ zIndex: selectedLayer === layer.id ? 30 : 20 + index }}
                          onClick={() => setSelectedLayer(layer.id)}
                          onMouseEnter={() => setHoveredLayer(layer.id)}
                          onMouseLeave={() => setHoveredLayer(null)}
                        >
                          <div
                            className={`absolute inset-0 transition-all ${
                              selectedLayer === layer.id ? 'ring-4 ring-yellow-400' : hoveredLayer === layer.id ? 'ring-2 ring-yellow-300' : ''
                            }`}
                            style={{
                              backgroundColor: layerColors[index % layerColors.length],
                              WebkitMaskImage: `url(${layer.maskUrl})`,
                              maskImage: `url(${layer.maskUrl})`,
                              WebkitMaskSize: '100% 100%',
                              maskSize: '100% 100%',
                              WebkitMaskRepeat: 'no-repeat',
                              maskRepeat: 'no-repeat',
                              opacity: selectedLayer === layer.id ? 0.6 : 0.4,
                              cursor: 'pointer',
                            }}
                          />
                          <div className="absolute top-2 left-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded text-xs font-medium text-slate-900 shadow-lg pointer-events-none">
                            {layer.name}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {selectionMode && !showLayerMap && (
                  <div className="absolute top-4 left-4 bg-purple-500 text-white px-3 py-2 rounded-lg text-sm shadow-lg z-30">
                    <MousePointer className="w-4 h-4 inline mr-2" />
                    Click on a layer to select it
                  </div>
                )}

                {showLayerMap && (
                  <div className="absolute bottom-4 left-4 right-4 bg-white/90 backdrop-blur-sm px-4 py-3 rounded-xl shadow-xl z-30">
                    <p className="text-xs text-slate-600 mb-2">Color Layer Map Active</p>
                    <p className="text-xs text-slate-500">Click on any colored region to select and edit that layer</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Properties */}
      <div className="w-80 bg-white border-l border-slate-200 p-6 overflow-auto">
        <h4 className="text-slate-900 mb-6">Layer Properties</h4>
        
        {selectedLayerData && (
          <div className="space-y-6">
            {/* Layer Info */}
            <div className="p-4 bg-slate-50 rounded-2xl">
              <p className="text-xs text-slate-500 mb-1">Selected Layer</p>
              <p className="text-sm text-slate-900">{selectedLayerData.name}</p>
              <p className="text-xs text-slate-600 mt-1 capitalize">{selectedLayerData.type.replace('-', ' ')}</p>
            </div>

            {/* Color Changer for extracted layers */}
            {selectedLayerData.isColorChangeable && (
              <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-green-600" />
                  <h5 className="text-sm text-slate-900">Smart Color Editor</h5>
                </div>
                <p className="text-xs text-slate-600 mb-3">
                  Change the color of this {selectedLayerData.name.toLowerCase()}. The AI will maintain realistic lighting and shadows.
                </p>
              </div>
            )}

            {/* Color Picker */}
            <div>
              <label className="block text-sm text-slate-700 mb-3">
                {selectedLayerData.isColorChangeable ? 'Change Color' : 'Layer Color'}
              </label>
              <div className="grid grid-cols-6 gap-2 mb-3">
                {['#FFFFFF', '#000000', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6', '#F97316', '#84CC16'].map((color) => (
                  <button
                    key={color}
                    onClick={() => updateLayerColor(color)}
                    className={`w-10 h-10 rounded-xl transition-all border-2 ${
                      selectedColor === color ? 'ring-4 ring-offset-2 ring-purple-500 border-white' : 'border-slate-200 hover:scale-110'
                    }`}
                    style={{ backgroundColor: color }}
                  >
                    {color === '#FFFFFF' && <div className="w-full h-full border border-slate-300 rounded-xl" />}
                  </button>
                ))}
              </div>
              <input
                type="color"
                value={selectedColor}
                onChange={(e) => updateLayerColor(e.target.value)}
                className="w-full h-12 rounded-xl border-2 border-slate-200 cursor-pointer"
              />
            </div>

            {/* Upload Logo / Custom Design */}
            <div>
              <label className="block text-sm text-slate-700 mb-3">
                <Upload className="w-4 h-4 inline mr-2" />
                Upload Logo/Design from PC
              </label>
              <button 
                onClick={() => logoInputRef.current?.click()}
                className="w-full px-4 py-4 border-2 border-dashed border-purple-300 rounded-xl hover:border-purple-400 hover:bg-purple-50 transition-all flex flex-col items-center justify-center gap-2 text-slate-600 bg-purple-50/50"
              >
                <ImageIcon className="w-8 h-8 text-purple-500" />
                <span className="text-sm">Click to upload</span>
                <span className="text-xs text-slate-500">PNG, SVG, JPEG - Max 10MB</span>
              </button>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="hidden"
              />
            </div>

            {/* Position Controls (for logos and uploaded images) */}
            {(selectedLayerData.type === 'logo' || selectedLayerData.type === 'uploaded') && (
              <div>
                <label className="block text-sm text-slate-700 mb-3">Position</label>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-8">X</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={selectedLayerData.position?.x || 50}
                      onChange={(e) => {
                        const newPos = { ...selectedLayerData.position, x: Number(e.target.value) } as any;
                        setLayers(layers.map(l => l.id === selectedLayer ? { ...l, position: newPos } : l));
                      }}
                      className="flex-1"
                    />
                    <span className="text-xs text-slate-600 w-12">{selectedLayerData.position?.x || 50}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-8">Y</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={selectedLayerData.position?.y || 50}
                      onChange={(e) => {
                        const newPos = { ...selectedLayerData.position, y: Number(e.target.value) } as any;
                        setLayers(layers.map(l => l.id === selectedLayer ? { ...l, position: newPos } : l));
                      }}
                      className="flex-1"
                    />
                    <span className="text-xs text-slate-600 w-12">{selectedLayerData.position?.y || 50}%</span>
                  </div>
                </div>
              </div>
            )}

            {/* Transform Controls */}
            <div>
              <label className="block text-sm text-slate-700 mb-3">Transform</label>
              <div className="space-y-2">
                <button className="w-full px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm text-slate-700 transition-colors flex items-center justify-center gap-2">
                  <RotateCw className="w-4 h-4" />
                  Rotate 90
                </button>
              </div>
            </div>

            {/* Alignment */}
            <div>
              <label className="block text-sm text-slate-700 mb-3">Alignment</label>
              <div className="grid grid-cols-3 gap-2">
                <button className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors">
                  <AlignLeft className="w-4 h-4 mx-auto" />
                </button>
                <button className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors">
                  <AlignCenter className="w-4 h-4 mx-auto" />
                </button>
                <button className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors">
                  <AlignRight className="w-4 h-4 mx-auto" />
                </button>
              </div>
            </div>

            {/* Size Controls */}
            {(selectedLayerData.type === 'logo' || selectedLayerData.type === 'uploaded') && (
              <div>
                <label className="block text-sm text-slate-700 mb-3">Scale</label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={(selectedLayerData.scale || 1) * 100}
                    onChange={(e) => {
                      setLayers(layers.map(l => l.id === selectedLayer ? { ...l, scale: Number(e.target.value) / 100 } : l));
                    }}
                    className="flex-1"
                  />
                  <span className="text-xs text-slate-600 w-12">{Math.round((selectedLayerData.scale || 1) * 100)}%</span>
                </div>
              </div>
            )}

            {/* Opacity */}
            <div>
              <label className="block text-sm text-slate-700 mb-3">Opacity</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round((selectedLayerData.opacity ?? 1) * 100)}
                  onChange={(e) => {
                    const nextOpacity = Number(e.target.value) / 100;
                    setLayers(layers.map(l => l.id === selectedLayer ? { ...l, opacity: nextOpacity } : l));
                  }}
                  className="flex-1"
                />
                <span className="text-xs text-slate-600 w-12">
                  {Math.round((selectedLayerData.opacity ?? 1) * 100)}%
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
