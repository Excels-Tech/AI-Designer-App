import { useState, useRef, useEffect, useMemo } from 'react';
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
import { renderComposite } from '../utils/composite';
import { authFetch, getUserId } from '../utils/auth';
import { RightSidePanel } from './video-creator/RightSidePanel';
import { RightDrawerMyDesigns } from './editor/RightDrawerMyDesigns';
import type { DesignCardItem } from './video-creator/DesignsGrid';
import { toast } from 'sonner@2.0.3';

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
  maskDataUrl?: string;
  color?: string;
  originalAverageColor?: string;
  isColorChangeable?: boolean;
  position?: { x: number; y: number };
  scale?: number;
  opacity?: number;
  blendMode?: GlobalCompositeOperation;
}

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '').trim();
  const value = normalized.length === 3 ? normalized.split('').map((ch) => ch + ch).join('') : normalized;
  const intVal = Number.parseInt(value, 16);
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255,
  };
}

function colorNameFromHex(hex?: string) {
  if (!hex) return 'Color';
  const { r, g, b } = hexToRgb(hex);
  const candidates: Array<{ name: string; rgb: [number, number, number] }> = [
    { name: 'Black', rgb: [20, 20, 20] },
    { name: 'White', rgb: [245, 245, 245] },
    { name: 'Gray', rgb: [160, 160, 160] },
    { name: 'Red', rgb: [220, 60, 60] },
    { name: 'Orange', rgb: [245, 140, 40] },
    { name: 'Yellow', rgb: [240, 220, 70] },
    { name: 'Green', rgb: [60, 180, 90] },
    { name: 'Blue', rgb: [70, 120, 240] },
    { name: 'Purple', rgb: [150, 90, 220] },
    { name: 'Pink', rgb: [240, 100, 180] },
    { name: 'Brown', rgb: [140, 95, 60] },
  ];
  let best = candidates[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const dr = r - c.rgb[0];
    const dg = g - c.rgb[1];
    const db = b - c.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best.name;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = src;
  });
}

async function makeCutoutPreview(imageDataUrl: string, maskDataUrl: string) {
  const [img, mask] = await Promise.all([loadImage(imageDataUrl), loadImage(maskDataUrl)]);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context not available.');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  return canvas.toDataURL('image/png');
}

function toDataUrl(inputUrlOrDataUrl: string): Promise<string> {
  if (inputUrlOrDataUrl.startsWith('data:')) {
    return Promise.resolve(inputUrlOrDataUrl);
  }

  const resolveApiFilesToVideoFiles = (input: string) => {
    try {
      const parsed = new URL(input, window.location.origin);
      if (!parsed.pathname.startsWith('/api/files/')) return input;
      const fileId = parsed.pathname.slice('/api/files/'.length);
      parsed.pathname = `/api/video/files/${fileId}`;
      parsed.searchParams.set('uid', getUserId());
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      if (!input.startsWith('/api/files/')) return input;
      const fileId = input.slice('/api/files/'.length);
      return `/api/video/files/${fileId}?uid=${encodeURIComponent(getUserId())}`;
    }
  };

  const fetchUrl = resolveApiFilesToVideoFiles(inputUrlOrDataUrl);

  const shouldUseAuthFetch = (() => {
    if (fetchUrl.startsWith('/api/')) return false;
    try {
      const parsed = new URL(fetchUrl, window.location.origin);
      if (parsed.pathname.startsWith('/api/video/files/')) return false;
      return parsed.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  })();

  const fetcher = shouldUseAuthFetch ? authFetch : fetch;

  return fetcher(fetchUrl, { mode: 'cors' } as any)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch image (HTTP ${res.status}).`);
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
  const [undoStack, setUndoStack] = useState<Layer[][]>([]);
  const [redoStack, setRedoStack] = useState<Layer[][]>([]);
  const [isMyDesignsOpen, setIsMyDesignsOpen] = useState(false);
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null);
  const [objectMaskDataUrl, setObjectMaskDataUrl] = useState<string | null>(null);
  const [hoveredMaskLayerId, setHoveredMaskLayerId] = useState<string | null>(null);
  const [maskCacheTick, setMaskCacheTick] = useState(0);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const layersRef = useRef<Layer[]>(layers);
  const baseImageRef = useRef<string | null>(null);
  const baseImageSizeRef = useRef<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const layerListRef = useRef<HTMLDivElement>(null);
  const layerCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const maskCacheRef = useRef<
    Map<string, { width: number; height: number; alpha: Uint8Array; outlineDataUrl?: string }>
  >(new Map());
  const rafRef = useRef<number | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const selectedLayerData = layers.find((l) => l.id === selectedLayer);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

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

  const commitLayers = (next: Layer[]) => {
    setUndoStack((prev) => [...prev, layersRef.current]);
    setRedoStack([]);
    setLayers(next);
  };

  useEffect(() => {
    const baseLayer = layers.find((l) => l.type === 'image' && l.imageUrl);
    const next = baseLayer?.imageUrl || null;
    const prev = baseImageRef.current;
    baseImageRef.current = next;
    if (!prev || !next || prev === next) return;

    setObjectMaskDataUrl(null);
    setShowLayerMap(false);
    setSelectionMode(false);
    setShowLayerExtractor(true);

    const cleaned = layersRef.current.filter((l) => l.type !== 'auto-extracted');
    if (cleaned.length !== layersRef.current.length) {
      commitLayers(cleaned);
      setSelectedLayer(cleaned.find((l) => l.type === 'image')?.id || cleaned[0]?.id || '1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.find((l) => l.type === 'image')?.imageUrl]);

  useEffect(() => {
    const baseLayer = layers.find((l) => l.type === 'image' && l.imageUrl);
    const url = baseLayer?.imageUrl;
    if (!url) return;
    let cancelled = false;
    loadImage(url)
      .then((img) => {
        if (cancelled) return;
        baseImageSizeRef.current = { width: img.width || 1024, height: img.height || 1024 };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [layers.find((l) => l.type === 'image')?.imageUrl]);

  useEffect(() => {
    const el = layerCardRefs.current.get(selectedLayer);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedLayer]);

  const extractedLayers = useMemo(
    () => layers.filter((l) => l.type === 'auto-extracted' && l.visible && (l.maskDataUrl || l.maskUrl)),
    [layers]
  );

  useEffect(() => {
    let cancelled = false;
    const ensureMaskCache = async (layer: Layer) => {
      if (!layer.maskDataUrl) return;
      if (maskCacheRef.current.has(layer.id)) return;
      const img = await loadImage(layer.maskDataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const alpha = new Uint8Array(canvas.width * canvas.height);
      for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) {
        alpha[p] = imageData.data[i]; // grayscale stored in RGB
      }

      // Build a 1px outline mask for clearer selection.
      const edge = new Uint8ClampedArray(canvas.width * canvas.height);
      const threshold = 20;
      for (let y = 1; y < canvas.height - 1; y += 1) {
        for (let x = 1; x < canvas.width - 1; x += 1) {
          const idx = y * canvas.width + x;
          if (alpha[idx] <= threshold) continue;
          const n =
            (alpha[idx - 1] > threshold ? 1 : 0) +
            (alpha[idx + 1] > threshold ? 1 : 0) +
            (alpha[idx - canvas.width] > threshold ? 1 : 0) +
            (alpha[idx + canvas.width] > threshold ? 1 : 0);
          if (n < 4) edge[idx] = 255;
        }
      }
      const outlinePng = await sharpEdgeToDataUrl(edge, canvas.width, canvas.height);

      maskCacheRef.current.set(layer.id, {
        width: canvas.width,
        height: canvas.height,
        alpha,
        outlineDataUrl: outlinePng,
      });
      setMaskCacheTick((v) => v + 1);
    };

    const run = async () => {
      for (const layer of extractedLayers) {
        await ensureMaskCache(layer);
        if (cancelled) return;
      }
    };

    run().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [extractedLayers]);

  function sharpEdgeToDataUrl(edge: Uint8ClampedArray, width: number, height: number) {
    // Minimal "dilate" by 1px for visibility.
    const dilated = new Uint8ClampedArray(edge.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        if (edge[idx]) {
          dilated[idx] = 255;
          dilated[idx - 1] = 255;
          dilated[idx + 1] = 255;
          dilated[idx - width] = 255;
          dilated[idx + width] = 255;
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(undefined);
    const imgData = ctx.createImageData(width, height);
    for (let i = 0; i < dilated.length; i += 1) {
      const v = dilated[i];
      const o = i * 4;
      imgData.data[o] = v;
      imgData.data[o + 1] = v;
      imgData.data[o + 2] = v;
      imgData.data[o + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return Promise.resolve(canvas.toDataURL('image/png'));
  }

  const getImageSpacePoint = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const imgW = baseImageSizeRef.current?.width || 1024;
    const imgH = baseImageSizeRef.current?.height || 1024;

    const scale = Math.min(rect.width / imgW, rect.height / imgH);
    const dispW = imgW * scale;
    const dispH = imgH * scale;
    const offsetX = (rect.width - dispW) / 2;
    const offsetY = (rect.height - dispH) / 2;
    const localX = x - offsetX;
    const localY = y - offsetY;
    if (localX < 0 || localY < 0 || localX > dispW || localY > dispH) return null;

    return {
      normX: localX / dispW,
      normY: localY / dispH,
    };
  };

  const hitTestMaskLayers = (normX: number, normY: number) => {
    const visible = layersRef.current.filter((l) => l.type === 'auto-extracted' && l.visible && l.maskDataUrl);
    const threshold = 20;
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const layer = visible[i];
      const cache = maskCacheRef.current.get(layer.id);
      if (!cache) continue;
      const px = Math.floor(Math.max(0, Math.min(1, normX)) * (cache.width - 1));
      const py = Math.floor(Math.max(0, Math.min(1, normY)) * (cache.height - 1));
      const v = cache.alpha[py * cache.width + px];
      if (v > threshold) return layer.id;
    }
    return null;
  };

  const scheduleHoverHitTest = (clientX: number, clientY: number) => {
    lastPointerRef.current = { x: clientX, y: clientY };
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (!showLayerMap) return;
      if (!layersRef.current.some((l) => l.type === 'auto-extracted')) return;
      const last = lastPointerRef.current;
      if (!last) return;
      const pt = getImageSpacePoint(last.x, last.y);
      if (!pt) {
        setHoveredMaskLayerId(null);
        return;
      }
      const hit = hitTestMaskLayers(pt.normX, pt.normY);
      setHoveredMaskLayerId(hit);
    });
  };

  const handleUndo = () => {
    setUndoStack((prev) => {
      if (!prev.length) return prev;
      const previous = prev[prev.length - 1];
      setRedoStack((redo) => [layersRef.current, ...redo]);
      setLayers(previous);
      return prev.slice(0, -1);
    });
  };

  const handleRedo = () => {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      const next = prev[0];
      setUndoStack((undo) => [...undo, layersRef.current]);
      setLayers(next);
      return prev.slice(1);
    });
  };

  const getCompositeDataUrl = async () => {
    const composite = await renderComposite(layersRef.current);
    setCompositePreview(composite);
    return composite;
  };

  const clearExtractedLayers = () => {
    setObjectMaskDataUrl(null);
    const cleaned = layersRef.current.filter((l) => l.type !== 'auto-extracted');
    if (cleaned.length !== layersRef.current.length) {
      commitLayers(cleaned);
      setSelectedLayer(cleaned.find((l) => l.type === 'image')?.id || cleaned[0]?.id || '1');
    }
  };

  const startLayerMapSelection = () => {
    setErrorMessage(null);
    setShowLayerExtractor(false);
    setShowLayerMap(true);
    setSelectionMode(true);
    clearExtractedLayers();
  };

  const pickObjectAndSplitColors = async (normX: number, normY: number) => {
    setIsExtracting(true);
    setErrorMessage(null);

    const baseLayer = layersRef.current.find((l) => l.type === 'image' && l.imageUrl);
    if (!baseLayer?.imageUrl) {
      setIsExtracting(false);
      setErrorMessage('Base image is missing.');
      return;
    }

    try {
      const imageDataUrl = await toDataUrl(baseLayer.imageUrl);
      const objectRes = await fetch('/api/sam2/object-from-point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, x: normX, y: normY }),
      });
      const objectData = await objectRes.json().catch(() => ({}));
      if (!objectRes.ok || objectData?.ok === false) {
        throw new Error(objectData?.error || 'Object selection failed.');
      }

      const objectMask = objectData?.objectMaskDataUrl as string | undefined;
      if (!objectMask) throw new Error('Object mask missing.');
      setObjectMaskDataUrl(objectMask);

      const splitRes = await fetch('/api/sam2/split-colors-in-mask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, objectMaskDataUrl: objectMask, max_colors: 6, min_area_ratio: 0.02 }),
      });
      const splitData = await splitRes.json().catch(() => ({}));
      if (!splitRes.ok || splitData?.ok === false) {
        throw new Error(splitData?.error || 'Color detection failed.');
      }

      const rawLayers: any[] = Array.isArray(splitData?.layers) ? splitData.layers : [];
      if (!rawLayers.length) {
        throw new Error('No colors detected on the selected object.');
      }

      const extractedLayers: Layer[] = await Promise.all(
        rawLayers.map(async (layer, idx) => {
          const maskDataUrl = layer.maskDataUrl as string;
          const avgColor = layer.avgColor as string;
          const preview = await makeCutoutPreview(imageDataUrl, maskDataUrl).catch(() => undefined);
          return {
            id: typeof layer.id === 'string' ? layer.id : `color-${idx + 1}`,
            name: `Shirt – ${colorNameFromHex(avgColor)}`,
            type: 'auto-extracted',
            visible: true,
            locked: false,
            imageUrl: preview,
            originalCutoutUrl: preview,
            maskUrl: maskDataUrl,
            maskDataUrl,
            originalAverageColor: avgColor,
            color: avgColor,
            isColorChangeable: true,
            opacity: 1,
          };
        })
      );

      const next = (() => {
        const prev = layersRef.current.filter((l) => l.type !== 'auto-extracted');
        const baseIndex = prev.findIndex((l) => l.type === 'image');
        const insertAt = baseIndex >= 0 ? baseIndex + 1 : 1;
        return [...prev.slice(0, insertAt), ...extractedLayers, ...prev.slice(insertAt)];
      })();

      commitLayers(next);
      setSelectedLayer(extractedLayers[0].id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Selection failed.';
      setErrorMessage(message);
      setObjectMaskDataUrl(null);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleSelectSavedDesign = async (item: DesignCardItem) => {
    setErrorMessage(null);
    setSelectedDesignId(item.id);
    try {
      const res = await authFetch(`/api/designs/${encodeURIComponent(item.id)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Failed to load design.');
      }
      const data = await res.json();
      const src =
        data?.composite?.dataUrl ||
        data?.composite?.url ||
        data?.images?.[0]?.dataUrl ||
        data?.images?.[0]?.url ||
        '';
      if (!src) {
        throw new Error('Design has no image to load.');
      }

      const imageDataUrl = await toDataUrl(src);

      const next = layersRef.current
        .filter((layer) => layer.type !== 'auto-extracted')
        .map((layer) => (layer.type === 'image' ? { ...layer, imageUrl: imageDataUrl, name: item.title || layer.name } : layer));

      setCompositePreview(null);
      setRealisticPreview(null);
      setShowRealisticPreview(false);
      setShowLayerMap(false);
      setSelectionMode(false);
      setShowLayerExtractor(true);
      commitLayers(next);
      setSelectedLayer(next.find((l) => l.type === 'image')?.id || next[0]?.id || '1');
      setIsMyDesignsOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load design.');
    }
  };

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
        commitLayers([...layersRef.current, newLayer]);
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
        commitLayers([...layersRef.current, logoLayer]);
        setSelectedLayer(logoLayer.id);
      };
      reader.readAsDataURL(file);
    }
  };

  // Enable click-to-select object + adaptive color layers (no fixed num_layers).
  const handleAutoExtractLayers = async () => {
    startLayerMapSelection();
  };

  // Generate realistic preview from edited layers
  const handleGenerateRealistic = async () => {
    setIsGeneratingRealistic(true);
    setErrorMessage(null);

    try {
      const composite = await getCompositeDataUrl();

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
    commitLayers(
      layersRef.current.map((layer) => (layer.id === id ? { ...layer, visible: !layer.visible } : layer))
    );
  };

  const toggleLayerLock = (id: string) => {
    commitLayers(
      layersRef.current.map((layer) => (layer.id === id ? { ...layer, locked: !layer.locked } : layer))
    );
  };

  const deleteLayer = (id: string) => {
    if (layers.length === 1) return;
    const next = layersRef.current.filter((layer) => layer.id !== id);
    commitLayers(next);
    if (selectedLayer === id) {
      setSelectedLayer(next[0]?.id || '1');
    }
  };

  const updateLayerColor = (color: string) => {
    if (!selectedLayerData || selectedLayerData.type !== 'auto-extracted' || !selectedLayerData.maskDataUrl) {
      toast('Click a region on the shirt to select it first');
      return;
    }
    setSelectedColor(color);
    commitLayers(layersRef.current.map((layer) => (layer.id === selectedLayer ? { ...layer, color } : layer)));
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

          <button
            type="button"
            onClick={() => setIsMyDesignsOpen(true)}
            className="w-full mt-3 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition-all flex items-center justify-center gap-2 text-sm"
          >
            <ImageIcon className="w-4 h-4" />
            Select from My Designs
          </button>
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
                  <span>Analyzing...</span>
                </>
              ) : (
                <>
                  <Scissors className="w-4 h-4" />
                  <span>Click Shirt to Detect Colors</span>
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
        <div className="px-4 pb-2">
          <button
            onClick={() => {
              if (showLayerMap) {
                setShowLayerMap(false);
                setSelectionMode(false);
                setObjectMaskDataUrl(null);
              } else {
                startLayerMapSelection();
              }
            }}
            className={`w-full px-4 py-2 rounded-xl text-sm flex items-center justify-center gap-2 transition-all ${
              showLayerMap
                ? 'bg-green-500 text-white shadow-lg'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            {showLayerMap ? 'Layer Map ON' : 'Layer Map'}
          </button>
        </div>
        
        <div ref={layerListRef} className="flex-1 overflow-auto p-4 space-y-2">
          {layers.map((layer) => (
            <div
              key={layer.id}
              ref={(el) => {
                if (el) layerCardRefs.current.set(layer.id, el);
                else layerCardRefs.current.delete(layer.id);
              }}
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
                {layer.type === 'auto-extracted' && (layer.originalAverageColor || layer.color) && (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded border border-white shadow-sm" style={{ backgroundColor: layer.color || layer.originalAverageColor }} />
                  </div>
                )}
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
            <button
              onClick={handleUndo}
              disabled={!undoStack.length}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors disabled:opacity-50"
            >
              <Undo className="w-5 h-5 text-slate-600" />
            </button>
            <button
              onClick={handleRedo}
              disabled={!redoStack.length}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors disabled:opacity-50"
            >
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
              onClick={async () => {
                try {
                  const output = realisticPreview || (await getCompositeDataUrl());
                  onComplete(output);
                } catch (err) {
                  setErrorMessage(err instanceof Error ? err.message : 'Failed to export design.');
                }
              }}
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
                          commitLayers(
                            layersRef.current.map((layer) =>
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
                          commitLayers([...layersRef.current, newLayer]);
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
              <div
                ref={canvasRef}
                className="relative w-full h-full bg-slate-50 rounded-2xl overflow-hidden"
                onMouseMove={(e) => {
                  if (!showLayerMap) return;
                  scheduleHoverHitTest(e.clientX, e.clientY);
                }}
                onMouseLeave={() => setHoveredMaskLayerId(null)}
                onClick={(e) => {
                  if (!showLayerMap || isExtracting) return;
                  const pt = getImageSpacePoint(e.clientX, e.clientY);
                  if (!pt) return;

                  const hasExtracted = layersRef.current.some((l) => l.type === 'auto-extracted');
                  if (!hasExtracted) {
                    pickObjectAndSplitColors(pt.normX, pt.normY);
                    return;
                  }

                  const hit = hitTestMaskLayers(pt.normX, pt.normY);
                  if (hit) {
                    setSelectedLayer(hit);
                    setHoveredMaskLayerId(hit);
                    return;
                  }
                }}
              >
                {/* Composite Preview */}
                {compositePreview ? (
                  <img
                    src={compositePreview}
                    alt="Composite preview"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                ) : (
                  layers[0]?.imageUrl && (
                    <img
                      src={layers[0].imageUrl}
                      alt="Base layer"
                      className="absolute inset-0 w-full h-full object-contain"
                    />
                  )
                )}

                {/* Color-Coded Layer Map Overlay */}
                {showLayerMap && (
                  <div className="absolute inset-0 z-20 pointer-events-none">
                    {objectMaskDataUrl && (
                      <div
                        className="absolute inset-0"
                        style={{
                          backgroundColor: 'rgba(34, 197, 94, 0.22)',
                          WebkitMaskImage: `url(${objectMaskDataUrl})`,
                          maskImage: `url(${objectMaskDataUrl})`,
                          WebkitMaskSize: '100% 100%',
                          maskSize: '100% 100%',
                          WebkitMaskRepeat: 'no-repeat',
                          maskRepeat: 'no-repeat',
                        }}
                      />
                    )}

                    {(() => {
                      // Force rerender when outlines are computed
                      void maskCacheTick;
                      const selected = layers.find((l) => l.id === selectedLayer && l.type === 'auto-extracted');
                      const hovered = layers.find((l) => l.id === hoveredMaskLayerId && l.type === 'auto-extracted');
                      const selectedOutline = selected ? maskCacheRef.current.get(selected.id)?.outlineDataUrl : undefined;
                      const hoveredOutline = hovered ? maskCacheRef.current.get(hovered.id)?.outlineDataUrl : undefined;

                      return (
                        <>
                          {hovered?.maskDataUrl && hovered.id !== selected?.id && (
                            <>
                              <div
                                className="absolute inset-0"
                                style={{
                                  backgroundColor: 'rgba(59, 130, 246, 0.22)',
                                  WebkitMaskImage: `url(${hovered.maskDataUrl})`,
                                  maskImage: `url(${hovered.maskDataUrl})`,
                                  WebkitMaskSize: '100% 100%',
                                  maskSize: '100% 100%',
                                  WebkitMaskRepeat: 'no-repeat',
                                  maskRepeat: 'no-repeat',
                                }}
                              />
                              {hoveredOutline && (
                                <div
                                  className="absolute inset-0"
                                  style={{
                                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                                    WebkitMaskImage: `url(${hoveredOutline})`,
                                    maskImage: `url(${hoveredOutline})`,
                                    WebkitMaskSize: '100% 100%',
                                    maskSize: '100% 100%',
                                    WebkitMaskRepeat: 'no-repeat',
                                    maskRepeat: 'no-repeat',
                                  }}
                                />
                              )}
                            </>
                          )}

                          {selected?.maskDataUrl && (
                            <>
                              <div
                                className="absolute inset-0"
                                style={{
                                  backgroundColor: 'rgba(234, 179, 8, 0.28)',
                                  WebkitMaskImage: `url(${selected.maskDataUrl})`,
                                  maskImage: `url(${selected.maskDataUrl})`,
                                  WebkitMaskSize: '100% 100%',
                                  maskSize: '100% 100%',
                                  WebkitMaskRepeat: 'no-repeat',
                                  maskRepeat: 'no-repeat',
                                }}
                              />
                              {selectedOutline && (
                                <div
                                  className="absolute inset-0"
                                  style={{
                                    backgroundColor: 'rgba(234, 179, 8, 0.95)',
                                    WebkitMaskImage: `url(${selectedOutline})`,
                                    maskImage: `url(${selectedOutline})`,
                                    WebkitMaskSize: '100% 100%',
                                    maskSize: '100% 100%',
                                    WebkitMaskRepeat: 'no-repeat',
                                    maskRepeat: 'no-repeat',
                                  }}
                                />
                              )}
                            </>
                          )}
                        </>
                      );
                    })()}
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
                    {layers.some((l) => l.type === 'auto-extracted') ? (
                      <>
                        <p className="text-xs text-slate-600 mb-2">Color Layer Map Active</p>
                        <p className="text-xs text-slate-500">Hover to preview, click to select a region</p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-slate-600 mb-2">Click the shirt</p>
                        <p className="text-xs text-slate-500">First click selects the garment, then detects only its real colors</p>
                      </>
                    )}
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
                        commitLayers(layersRef.current.map((l) => (l.id === selectedLayer ? { ...l, position: newPos } : l)));
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
                        commitLayers(layersRef.current.map((l) => (l.id === selectedLayer ? { ...l, position: newPos } : l)));
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
                      commitLayers(
                        layersRef.current.map((l) =>
                          l.id === selectedLayer ? { ...l, scale: Number(e.target.value) / 100 } : l
                        )
                      );
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
                    commitLayers(layersRef.current.map((l) => (l.id === selectedLayer ? { ...l, opacity: nextOpacity } : l)));
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

      <RightSidePanel
        open={isMyDesignsOpen}
        title="My Designs"
        subtitle="Select a saved design to load into the editor."
        onClose={() => setIsMyDesignsOpen(false)}
      >
        <RightDrawerMyDesigns
          open
          onClose={() => setIsMyDesignsOpen(false)}
          selectedDesignId={selectedDesignId}
          onSelectDesign={handleSelectSavedDesign}
        />
      </RightSidePanel>
    </div>
  );
}
