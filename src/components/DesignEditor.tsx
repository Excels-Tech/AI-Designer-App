import { useState, useRef } from 'react';
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

interface DesignEditorProps {
  baseImages: string[];
  onComplete: (designUrl: string) => void;
}

interface Layer {
  id: string;
  name: string;
  type: 'image' | 'text' | 'logo' | 'auto-extracted' | 'uploaded';
  visible: boolean;
  locked: boolean;
  imageUrl?: string;
  color?: string;
  isColorChangeable?: boolean;
  position?: { x: number; y: number };
  scale?: number;
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
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const selectedLayerData = layers.find((l) => l.id === selectedLayer);

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

  // Auto-extract layers from realistic image with color-based detection
  const handleAutoExtractLayers = () => {
    setIsExtracting(true);
    setShowLayerExtractor(false);
    
    // Simulate AI color-based layer extraction
    setTimeout(() => {
      const extractedLayers: Layer[] = [
        { 
          id: 'layer-background', 
          name: 'Background', 
          type: 'auto-extracted', 
          visible: true, 
          locked: false, 
          imageUrl: 'https://images.unsplash.com/photo-1557683316-973673baf926?w=800&h=800&fit=crop',
          color: '#F8FAFC',
          isColorChangeable: true
        },
        { 
          id: 'layer-color1', 
          name: 'Shirt Body (Blue)', 
          type: 'auto-extracted', 
          visible: true, 
          locked: false, 
          imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&h=800&fit=crop',
          color: '#1E40AF',
          isColorChangeable: true
        },
        { 
          id: 'layer-color2', 
          name: 'Sleeves Stripe (White)', 
          type: 'auto-extracted', 
          visible: true, 
          locked: false, 
          imageUrl: 'https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=800&h=800&fit=crop',
          color: '#FFFFFF',
          isColorChangeable: true
        },
        { 
          id: 'layer-collar', 
          name: 'Collar (Navy)', 
          type: 'auto-extracted', 
          visible: true, 
          locked: false, 
          imageUrl: 'https://images.unsplash.com/photo-1622445275463-afa2ab738c34?w=400&h=400&fit=crop',
          color: '#1E3A8A',
          isColorChangeable: true
        },
        { 
          id: 'layer-number', 
          name: 'Number/Text (White)', 
          type: 'auto-extracted', 
          visible: true, 
          locked: false, 
          imageUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&h=400&fit=crop',
          color: '#FFFFFF',
          isColorChangeable: true
        },
      ];
      
      setLayers([...layers, ...extractedLayers]);
      setIsExtracting(false);
      setSelectedLayer('layer-color1');
      setShowLayerMap(true); // Show layer map after extraction
      setSelectionMode(true); // Enable selection mode
    }, 3000);
  };

  // Generate realistic preview from edited layers
  const handleGenerateRealistic = () => {
    setIsGeneratingRealistic(true);
    
    // Simulate realistic rendering
    setTimeout(() => {
      setRealisticPreview('https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=1200&h=1200&fit=crop');
      setIsGeneratingRealistic(false);
      setShowRealisticPreview(true);
    }, 4000);
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

  const updateLayerColor = (color: string) => {
    setSelectedColor(color);
    setLayers(layers.map((layer) =>
      layer.id === selectedLayer ? { ...layer, color } : layer
    ));
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

        {/* Canvas */}
        <div className="flex-1 p-8 overflow-auto flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
          {showRealisticPreview && realisticPreview ? (
            // Realistic Preview Mode
            <div className="space-y-6 max-w-4xl">
              <div className="text-center">
                <h3 className="text-slate-900 mb-2">Realistic Preview Generated! ✨</h3>
                <p className="text-slate-600 mb-4">Your edited design has been converted to a photorealistic image</p>
                <button
                  onClick={() => setShowRealisticPreview(false)}
                  className="text-sm text-purple-600 hover:text-purple-700"
                >
                  ← Back to layer editor
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-6">
                {/* Before */}
                <div>
                  <p className="text-sm text-slate-600 mb-3 text-center">Before (Layers)</p>
                  <div className="relative bg-white rounded-3xl shadow-2xl p-8" style={{ width: '400px', height: '400px' }}>
                    <div className="relative w-full h-full bg-slate-50 rounded-2xl overflow-hidden">
                      {layers.filter(l => l.visible).slice(0, 3).map((layer) => (
                        <div key={layer.id} className="absolute inset-0">
                          {layer.imageUrl && (
                            <img
                              src={layer.imageUrl}
                              alt={layer.name}
                              className="w-full h-full object-cover opacity-50"
                            />
                          )}
                        </div>
                      ))}
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
                {/* Base Image Layers */}
                {layers.filter(l => l.visible).map((layer, index) => (
                  <div
                    key={layer.id}
                    className={`absolute transition-all ${
                      selectedLayer === layer.id ? 'ring-4 ring-purple-500 ring-inset z-10' : ''
                    }`}
                    style={{
                      left: layer.position ? `${layer.position.x}%` : '0',
                      top: layer.position ? `${layer.position.y}%` : '0',
                      width: layer.scale ? `${layer.scale * 100}%` : '100%',
                      height: layer.scale ? `${layer.scale * 100}%` : '100%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: index,
                    }}
                    onClick={() => selectionMode && layer.type === 'auto-extracted' && setSelectedLayer(layer.id)}
                  >
                    {layer.imageUrl && (
                      <img
                        src={layer.imageUrl}
                        alt={layer.name}
                        className="w-full h-full object-cover cursor-pointer"
                        style={layer.isColorChangeable && layer.color ? { 
                          filter: `hue-rotate(${layer.color === '#FFFFFF' ? '0' : layer.color === '#000000' ? '180' : '45'}deg) saturate(${layer.color === '#FFFFFF' ? '0' : '1.5'})`,
                        } : {}}
                      />
                    )}
                  </div>
                ))}

                {/* Color-Coded Layer Map Overlay */}
                {showLayerMap && (
                  <div className="absolute inset-0 z-20 pointer-events-none">
                    {layers.filter(l => l.type === 'auto-extracted' && l.visible).map((layer, index) => {
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
                          className={`absolute transition-all border-4 ${
                            selectedLayer === layer.id 
                              ? 'border-yellow-400 shadow-2xl' 
                              : hoveredLayer === layer.id
                              ? 'border-yellow-300'
                              : 'border-white'
                          }`}
                          style={{
                            left: index === 0 ? '10%' : index === 1 ? '30%' : index === 2 ? '60%' : index === 3 ? '20%' : '50%',
                            top: index === 0 ? '10%' : index === 1 ? '35%' : index === 2 ? '35%' : index === 3 ? '15%' : '65%',
                            width: index === 0 ? '80%' : index === 1 ? '60%' : index === 2 ? '25%' : index === 3 ? '60%' : '40%',
                            height: index === 0 ? '80%' : index === 1 ? '50%' : index === 2 ? '20%' : index === 3 ? '15%' : '25%',
                            backgroundColor: layerColors[index % layerColors.length],
                            zIndex: selectedLayer === layer.id ? 30 : 20 + index,
                            pointerEvents: 'auto',
                            cursor: 'pointer',
                          }}
                          onClick={() => setSelectedLayer(layer.id)}
                          onMouseEnter={() => setHoveredLayer(layer.id)}
                          onMouseLeave={() => setHoveredLayer(null)}
                        >
                          <div className="absolute top-2 left-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded text-xs font-medium text-slate-900 shadow-lg">
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
                    <p className="text-xs text-slate-600 mb-2">🎨 Color Layer Map Active</p>
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
                <span className="text-xs text-slate-500">PNG, SVG, JPEG • Max 10MB</span>
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
                  Rotate 90°
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
                  defaultValue="100"
                  className="flex-1"
                />
                <span className="text-xs text-slate-600 w-12">100%</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}