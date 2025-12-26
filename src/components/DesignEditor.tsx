import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Move, Save, Type, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch, getUserId } from '../utils/auth';

interface DesignEditorProps {
  baseImages: string[];
  onComplete: (designUrl: string) => void;
}

type TextFontId = 'inter' | 'poppins' | 'serif' | 'mono';
type TextLayer = {
  id: string;
  text: string;
  xNorm: number;
  yNorm: number;
  color: string;
  fontSize: number;
  fontId: TextFontId;
};
type LogoLayer = { id: string; src: string; xNorm: number; yNorm: number; scale: number; rotation: number };
type ImageDimensions = { width: number; height: number };

const COLOR_SWATCHES = [
  '#FFFFFF',
  '#000000',
  '#EF4444',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#6366F1',
  '#14B8A6',
  '#F97316',
  '#84CC16',
];

const CANVAS_MAX_PX = 720;

const FONT_OPTIONS: Array<{ id: TextFontId; label: string; css: string }> = [
  { id: 'inter', label: 'Inter', css: '"Inter", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial' },
  { id: 'poppins', label: 'Poppins', css: '"Poppins", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' },
];

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function loadNaturalDimensions(src: string): Promise<ImageDimensions> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) {
        reject(new Error('Invalid image dimensions.'));
        return;
      }
      resolve({ width, height });
    };
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = src;
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
}

function withUid(url: string) {
  if (!url) return url;
  if (!url.startsWith('/api/')) return url;
  if (/[?&]uid=/i.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}uid=${encodeURIComponent(getUserId())}`;
}

export function DesignEditor({ baseImages, onComplete }: DesignEditorProps) {
  const [baseImageSrc, setBaseImageSrc] = useState<string | null>(baseImages[0] ?? null);
  const [baseImageDims, setBaseImageDims] = useState<ImageDimensions | null>(null);
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [logoLayers, setLogoLayers] = useState<LogoLayer[]>([]);
  const [logoDimsById, setLogoDimsById] = useState<Record<string, ImageDimensions>>({});
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedLogoId, setSelectedLogoId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [canvasPx, setCanvasPx] = useState<number>(CANVAS_MAX_PX);

  const [myDesignsOpen, setMyDesignsOpen] = useState(false);
  const [designsLoading, setDesignsLoading] = useState(false);
  const [designsError, setDesignsError] = useState<string | null>(null);
  const [designItems, setDesignItems] = useState<Array<{ id: string; title: string; thumbnail: string }>>([]);
  const [designThumbObjectUrls, setDesignThumbObjectUrls] = useState<Record<string, string>>({});

  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);

  const placeholderThumb =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#64748b" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial" font-size="18">Preview unavailable</text></svg>`
    );

  const baseUploadRef = useRef<HTMLInputElement | null>(null);
  const logoUploadRef = useRef<HTMLInputElement | null>(null);
  const stageOuterRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pinnedBaseObjectUrlRef = useRef<string | null>(null);
  const freezeCanvasResizeRef = useRef(false);
  const saveNameInputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<
    | null
    | {
        kind: 'text' | 'logo';
        id: string;
        startClientX: number;
        startClientY: number;
        startXNorm: number;
        startYNorm: number;
        hasMoved: boolean;
      }
  >(null);

  const getTextLayersSnapshot = () => {
    const nodes = textNodeRefs.current;
    return textLayers.map((layer) => {
      const node = nodes.get(layer.id);
      if (!node) return layer;
      const nextText = (node.textContent || '').trim();
      return nextText ? { ...layer, text: nextText } : layer;
    });
  };

  const commitEditingTextToState = () => {
    if (!editingTextId) return;
    const node = textNodeRefs.current.get(editingTextId);
    const nextText = (node?.textContent || '').trim();
    if (nextText) {
      setTextLayers((prev) => prev.map((t) => (t.id === editingTextId ? { ...t, text: nextText } : t)));
    }
    setEditingTextId(null);
    if (node) node.blur();
  };

  useEffect(() => {
    if (!editingTextId) return;
    const node = textNodeRefs.current.get(editingTextId);
    if (!node) return;
    node.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [editingTextId]);

  useEffect(() => {
    if (!baseImageSrc) {
      setBaseImageDims(null);
      return;
    }
    let cancelled = false;
    void loadNaturalDimensions(baseImageSrc)
      .then((dims) => {
        if (cancelled) return;
        setBaseImageDims(dims);
      })
      .catch(() => {
        if (cancelled) return;
        setBaseImageDims(null);
      });
    return () => {
      cancelled = true;
    };
  }, [baseImageSrc]);

  useEffect(() => {
    return () => {
      if (pinnedBaseObjectUrlRef.current) {
        URL.revokeObjectURL(pinnedBaseObjectUrlRef.current);
      }
    };
  }, []);

  const isApiFileUrl = (src: string) => src.startsWith('/api/files/') || src.startsWith('/api/video/files/');
  const fetchAsObjectUrl = async (src: string) => {
    const res = await authFetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  useEffect(() => {
    freezeCanvasResizeRef.current = myDesignsOpen || saving;
  }, [myDesignsOpen, saving]);

  useEffect(() => {
    const root = stageOuterRef.current;
    if (!root) return;
    const ro = new ResizeObserver((entries) => {
      if (freezeCanvasResizeRef.current) return;
      const rect = entries[0]?.contentRect;
      if (!rect?.width) return;
      const next = Math.min(CANVAS_MAX_PX, Math.round(rect.width));
      // Avoid tiny layout/scrollbar jitters (e.g. modal open/close) from rescaling the stage,
      // which can make layers appear to "jump" even though their normalized coords are unchanged.
      setCanvasPx((prev) => (Math.abs(prev - next) <= 2 ? prev : next));
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const display = useMemo(() => {
    const size = canvasPx || CANVAS_MAX_PX;
    if (!baseImageDims) {
      return { size, scale: 1, offsetX: 0, offsetY: 0 };
    }
    const scale = Math.min(size / baseImageDims.width, size / baseImageDims.height);
    const drawnW = baseImageDims.width * scale;
    const drawnH = baseImageDims.height * scale;
    const offsetX = (size - drawnW) / 2;
    const offsetY = (size - drawnH) / 2;
    return { size, scale, offsetX, offsetY };
  }, [baseImageDims, canvasPx]);

  const selectedText = useMemo(
    () => (selectedTextId ? textLayers.find((layer) => layer.id === selectedTextId) ?? null : null),
    [selectedTextId, textLayers]
  );
  const selectedLogo = useMemo(
    () => (selectedLogoId ? logoLayers.find((layer) => layer.id === selectedLogoId) ?? null : null),
    [logoLayers, selectedLogoId]
  );

  const clearSelection = () => {
    setSelectedTextId(null);
    setSelectedLogoId(null);
    setEditingTextId(null);
  };

  const handleBaseUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please upload an image file');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    setBaseImageSrc(dataUrl);
    clearSelection();
  };

  useEffect(() => {
    if (!myDesignsOpen) return;
    let cancelled = false;
    setDesignsLoading(true);
    setDesignsError(null);
    setDesignThumbObjectUrls((prev) => prev);
    void (async () => {
      try {
        const res = await authFetch('/api/designs?limit=24');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load designs.');
        }
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const normalized = items
          .map((item: any) => ({
            id: String(item.id ?? ''),
            title: String(item.title ?? item.name ?? 'Untitled Design'),
            thumbnail: withUid(String(item.thumbnail ?? '')),
          }))
          .filter((item: any) => item.id && item.thumbnail);
        if (cancelled) return;
        setDesignItems(normalized);
      } catch (err: any) {
        if (cancelled) return;
        setDesignsError(err?.message || 'Failed to load designs.');
      } finally {
        if (cancelled) return;
        setDesignsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [myDesignsOpen]);

  useEffect(() => {
    if (!myDesignsOpen) return;
    let cancelled = false;

    void (async () => {
      const toFetch = designItems.filter((d) => isApiFileUrl(d.thumbnail) && !designThumbObjectUrls[d.id]);
      if (!toFetch.length) return;
      const entries = await Promise.all(
        toFetch.map(async (item) => {
          const url = await fetchAsObjectUrl(item.thumbnail);
          return url ? ([item.id, url] as const) : null;
        })
      );
      if (cancelled) {
        entries.forEach((entry) => {
          if (entry) URL.revokeObjectURL(entry[1]);
        });
        return;
      }
      setDesignThumbObjectUrls((prev) => {
        const next = { ...prev };
        entries.forEach((entry) => {
          if (!entry) return;
          const [id, url] = entry;
          next[id] = url;
        });
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [designItems, designThumbObjectUrls, myDesignsOpen]);

  useEffect(() => {
    if (myDesignsOpen) return;
    const urls = Object.values(designThumbObjectUrls);
    if (!urls.length) return;
    const pinned = pinnedBaseObjectUrlRef.current;
    urls.forEach((u) => {
      if (pinned && u === pinned) return;
      URL.revokeObjectURL(u);
    });
    setDesignThumbObjectUrls({});
  }, [designThumbObjectUrls, myDesignsOpen]);

  const handleAddText = () => {
    if (!baseImageDims) {
      toast('Upload a base image first');
      return;
    }
    const id = crypto.randomUUID();
    const next: TextLayer = {
      id,
      text: 'Double-click to edit',
      xNorm: 0.5,
      yNorm: 0.15,
      color: '#8B5CF6',
      fontSize: 56,
      fontId: 'inter',
    };
    setTextLayers((prev) => [...prev, next]);
    setSelectedTextId(id);
    setSelectedLogoId(null);
  };

  const handleLogoUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please upload an image file');
      return;
    }
    if (!baseImageDims) {
      toast('Upload a base image first');
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const dims = await loadNaturalDimensions(dataUrl).catch(() => null);
    const id = crypto.randomUUID();

    const next: LogoLayer = {
      id,
      src: dataUrl,
      xNorm: 0.5,
      yNorm: 0.5,
      scale: 1,
      rotation: 0,
    };

    setLogoLayers((prev) => [...prev, next]);
    if (dims) {
      setLogoDimsById((prev) => ({ ...prev, [id]: dims }));
    }
    setSelectedLogoId(id);
    setSelectedTextId(null);
  };

  const startDrag = (kind: 'text' | 'logo', id: string, clientX: number, clientY: number) => {
    if (!baseImageDims) return;
    const source =
      kind === 'text'
        ? textLayers.find((layer) => layer.id === id)
        : logoLayers.find((layer) => layer.id === id);
    if (!source) return;
    dragRef.current = {
      kind,
      id,
      startClientX: clientX,
      startClientY: clientY,
      startXNorm: source.xNorm,
      startYNorm: source.yNorm,
      hasMoved: false,
    };
  };

  const applyDragMove = (clientX: number, clientY: number) => {
    if (!baseImageDims) return;
    const drag = dragRef.current;
    if (!drag) return;
    const dxDisplay = clientX - drag.startClientX;
    const dyDisplay = clientY - drag.startClientY;
    if (!drag.hasMoved && Math.abs(dxDisplay) < 2 && Math.abs(dyDisplay) < 2) return;
    drag.hasMoved = true;
    const invScale = display.scale ? 1 / display.scale : 1;
    const startX = drag.startXNorm * baseImageDims.width;
    const startY = drag.startYNorm * baseImageDims.height;
    const nextX = clamp(startX + dxDisplay * invScale, 0, baseImageDims.width);
    const nextY = clamp(startY + dyDisplay * invScale, 0, baseImageDims.height);
    const nextXNorm = baseImageDims.width ? nextX / baseImageDims.width : 0;
    const nextYNorm = baseImageDims.height ? nextY / baseImageDims.height : 0;

    if (drag.kind === 'text') {
      setTextLayers((prev) =>
        prev.map((layer) => (layer.id === drag.id ? { ...layer, xNorm: nextXNorm, yNorm: nextYNorm } : layer))
      );
    } else {
      setLogoLayers((prev) =>
        prev.map((layer) => (layer.id === drag.id ? { ...layer, xNorm: nextXNorm, yNorm: nextYNorm } : layer))
      );
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const exportBlob = async (): Promise<Blob> => {
    if (!baseImageSrc || !baseImageDims) {
      throw new Error('Upload a base image first');
    }

    const textSnapshot = getTextLayersSnapshot();
    // Let layout settle so DOM measurements (getBoundingClientRect) match what the user sees.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    // Ensure web fonts are loaded before we measure/draw text on canvas,
    // otherwise the export can use fallback metrics and appear misaligned vs the UI.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fonts = (document as any).fonts as FontFaceSet | undefined;
      if (fonts?.ready) await fonts.ready;
      await Promise.all(
        textSnapshot.map(async (layer) => {
          const fontCss = FONT_OPTIONS.find((opt) => opt.id === layer.fontId)?.css ?? FONT_OPTIONS[0].css;
          try {
            await fonts?.load?.(`400 ${layer.fontSize}px ${fontCss}`, layer.text || 'abc');
          } catch {
            // ignore font loading errors and fall back
          }
        })
      );
    } catch {
      // ignore font readiness errors and fall back
    }

    const canvas = document.createElement('canvas');
    canvas.width = baseImageDims.width;
    canvas.height = baseImageDims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');

    const baseImg = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load base image'));
      img.src = baseImageSrc;
    });

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);

    const stageRect = stageRef.current?.getBoundingClientRect() ?? null;
    const exportStageSize = stageRect ? Math.min(stageRect.width, stageRect.height) : 0;
    const exportScale = exportStageSize
      ? Math.min(exportStageSize / baseImageDims.width, exportStageSize / baseImageDims.height)
      : display.scale;
    const exportOffsetX = exportStageSize ? (exportStageSize - baseImageDims.width * exportScale) / 2 : display.offsetX;
    const exportOffsetY = exportStageSize ? (exportStageSize - baseImageDims.height * exportScale) / 2 : display.offsetY;

    for (const layer of logoLayers) {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Failed to load logo'));
        el.src = layer.src;
      });

      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      ctx.save();
      ctx.translate(layer.xNorm * baseImageDims.width, layer.yNorm * baseImageDims.height);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.scale(layer.scale, layer.scale);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    for (const layer of textSnapshot) {
      const fontCss = FONT_OPTIONS.find((opt) => opt.id === layer.fontId)?.css ?? FONT_OPTIONS[0].css;
      ctx.save();
      ctx.fillStyle = layer.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `400 ${layer.fontSize}px ${fontCss}`;

      const lines = String(layer.text || '').split(/\r?\n/);
      const lineHeight = layer.fontSize * 1.1;

      // Derive the exact DOM text-box position/size (what the user sees) and map it back to base-image px.
      // This avoids subtle DOM vs canvas metric differences that can cause visible x-shifts on export.
      let xCenter = layer.xNorm * baseImageDims.width;
      let yCenter = layer.yNorm * baseImageDims.height;
      let boxWidth = 0;

      const node = textNodeRefs.current.get(layer.id);
      if (node && stageRect && exportScale) {
        const rect = node.getBoundingClientRect();
        const leftStage = rect.left - stageRect.left;
        const topStage = rect.top - stageRect.top;

        const boxWidthStage = rect.width;
        const boxHeightStage = rect.height;

        const leftImage = (leftStage - exportOffsetX) / exportScale;
        const centerYImage = (topStage + boxHeightStage / 2 - exportOffsetY) / exportScale;

        boxWidth = boxWidthStage / exportScale;
        xCenter = leftImage + boxWidth / 2;
        yCenter = centerYImage;
      }

      if (!boxWidth || !Number.isFinite(boxWidth)) {
        boxWidth = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
      }

      const xLeft = xCenter - boxWidth / 2;
      const startY = yCenter - ((lines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const textWidth = ctx.measureText(line).width;
        const x = xLeft + (boxWidth - textWidth) / 2;
        ctx.fillText(line, x, startY + i * lineHeight);
      }
      ctx.restore();
    }

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (!result) reject(new Error('Failed to export image.'));
        else resolve(result);
      }, 'image/png');
    });
  };

  const downloadExport = async () => {
    try {
      commitEditingTextToState();
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(saveName.trim() || 'design').slice(0, 60)}.png`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast(err?.message || 'Failed to download.');
    }
  };

  const saveToMyDesigns = async () => {
    const name = saveName.trim();
    if (!name) {
      toast('File name is required');
      return;
    }
    // Freeze canvas resizing immediately so UI/layout changes during save don't rescale the stage
    // (which makes layers appear to "shift").
    freezeCanvasResizeRef.current = true;
    setSaving(true);
    try {
      commitEditingTextToState();
      const blob = await exportBlob();
      const dataUrl = await blobToDataUrl(blob);
      const uid = getUserId();
      const res = await authFetch('/api/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.slice(0, 60),
          title: name.slice(0, 60),
          prompt: 'Edited in editor',
          userId: uid,
          style: 'realistic',
          resolution: 1024,
          views: ['front'],
          composite: dataUrl,
          images: [{ view: 'front', dataUrl }],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save.');
      }
      toast('Saved to My Designs');
      onComplete(dataUrl);
    } catch (err: any) {
      toast(err?.message || 'Failed to save.');
    } finally {
      setSaving(false);
      freezeCanvasResizeRef.current = myDesignsOpen;
    }
  };

  return (
    <div className="h-screen flex bg-slate-50">
      <aside className="w-80 bg-white border-r border-slate-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-slate-900">Editor</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                endDrag();
                commitEditingTextToState();
                if (!saveName.trim()) {
                  toast('File name is required');
                  saveNameInputRef.current?.focus();
                  return;
                }
                void saveToMyDesigns();
              }}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 text-white text-sm hover:shadow-lg hover:shadow-purple-500/30"
            >
              <Save className="w-4 h-4" />
              Save
            </button>
            <button
              type="button"
              onClick={() => void downloadExport()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-sm hover:border-purple-300"
            >
              Download
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
          <p className="text-sm text-slate-900 font-medium">Base Image</p>
          <button
            type="button"
            onClick={() => baseUploadRef.current?.click()}
            className="w-full px-4 py-4 border-2 border-dashed border-slate-300 rounded-xl hover:border-purple-300 hover:bg-purple-50 transition-all flex flex-col items-center justify-center gap-2 text-slate-600"
          >
            <Upload className="w-6 h-6 text-slate-600" />
            <span className="text-sm">Upload base image</span>
            <span className="text-xs text-slate-500">PNG, JPG, WEBP</span>
          </button>
          <button
            type="button"
            onClick={() => {
              endDrag();
              setMyDesignsOpen(true);
            }}
            className="w-full h-[44px] rounded-xl border border-slate-200 bg-white hover:border-purple-300 hover:bg-slate-50 text-slate-800 text-sm inline-flex items-center justify-center gap-2"
          >
            Select from My Designs
          </button>
          <input
            ref={baseUploadRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void handleBaseUpload(e.target.files);
              e.currentTarget.value = '';
            }}
          />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
          <p className="text-sm text-slate-900 font-medium">Tools</p>

          <button
            type="button"
            onClick={handleAddText}
            className="w-full h-[48px] rounded-xl border border-slate-200 bg-white hover:border-purple-300 hover:bg-slate-50 text-slate-800 text-sm inline-flex items-center justify-center gap-2"
          >
            <Type className="w-4 h-4 text-slate-600" />
            Add Text
          </button>

          <button
            type="button"
            onClick={() => logoUploadRef.current?.click()}
            className="w-full h-[48px] rounded-xl border border-slate-200 bg-white hover:border-purple-300 hover:bg-slate-50 text-slate-800 text-sm inline-flex items-center justify-center gap-2"
          >
            <ImageIcon className="w-4 h-4 text-slate-600" />
            Upload Logo/Design
          </button>
          <input
            ref={logoUploadRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void handleLogoUpload(e.target.files);
              e.currentTarget.value = '';
            }}
          />

          <p className="text-xs text-slate-500">
            Tip: Click a layer to select it. Drag to move. Double-click text to edit.
          </p>
        </div>
      </aside>

      <main className="flex-1 p-8">
        <div className="mx-auto max-w-[1100px]">
          <div className="rounded-3xl border border-slate-200 bg-white shadow-xl p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <Move className="w-4 h-4 text-slate-600" />
                Canvas
              </div>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-slate-600 hover:text-slate-900"
              >
                Clear selection
              </button>
            </div>

            <div className="mt-5 flex justify-center">
              <div
                ref={stageOuterRef}
                className="w-full max-w-[720px] aspect-square rounded-2xl border border-slate-200 bg-white overflow-hidden flex items-center justify-center"
              >
                <div
                  ref={stageRef}
                  className="relative w-full h-full select-none"
                  onPointerMove={(e) => {
                    if (!dragRef.current) return;
                    applyDragMove(e.clientX, e.clientY);
                  }}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onPointerLeave={endDrag}
                  onPointerDown={() => {
                    clearSelection();
                  }}
                >
                  {baseImageSrc ? (
                    <img
                      src={baseImageSrc}
                      alt="Base"
                      className="absolute inset-0 w-full h-full object-contain"
                      draggable={false}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
                      Upload a base image to start.
                    </div>
                  )}

                {logoLayers.map((layer) => {
                  if (!baseImageDims) return null;
                  const dims = logoDimsById[layer.id];
                  const w = dims ? dims.width * display.scale : 160;
                  const h = dims ? dims.height * display.scale : 160;
                  const left = display.offsetX + layer.xNorm * baseImageDims.width * display.scale;
                  const top = display.offsetY + layer.yNorm * baseImageDims.height * display.scale;
                  const isSelected = selectedLogoId === layer.id;

                  return (
                    <div
                      key={layer.id}
                      className="absolute"
                      style={{
                        left,
                        top,
                        width: w,
                        height: h,
                        transform: `translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale})`,
                        transformOrigin: 'center',
                        zIndex: 20,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedLogoId(layer.id);
                        setSelectedTextId(null);
                        startDrag('logo', layer.id, e.clientX, e.clientY);
                        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                      }}
                      onPointerUp={(e) => {
                        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                        endDrag();
                      }}
                    >
                      <div
                        className={
                          isSelected
                            ? 'w-full h-full rounded-xl ring-2 ring-purple-400 ring-offset-2 ring-offset-transparent'
                            : 'w-full h-full'
                        }
                      >
                        <img src={layer.src} alt="Logo" className="w-full h-full object-contain" draggable={false} />
                      </div>
                    </div>
                  );
                })}

                {textLayers.map((layer) => {
                  if (!baseImageDims) return null;
                  const left = display.offsetX + layer.xNorm * baseImageDims.width * display.scale;
                  const top = display.offsetY + layer.yNorm * baseImageDims.height * display.scale;
                  const isSelected = selectedTextId === layer.id;
                  const isEditing = editingTextId === layer.id;
                  const fontCss = FONT_OPTIONS.find((opt) => opt.id === layer.fontId)?.css ?? FONT_OPTIONS[0].css;

                  return (
                    <div
                      key={layer.id}
                      className="absolute"
                      style={{ left, top, transform: 'translate(-50%, -50%)', zIndex: 30 }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setSelectedTextId(layer.id);
                        setSelectedLogoId(null);
                        setEditingTextId(layer.id);
                        dragRef.current = null;
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (isEditing) return;
                        if (e.detail > 1) return;
                        setSelectedTextId(layer.id);
                        setSelectedLogoId(null);
                        startDrag('text', layer.id, e.clientX, e.clientY);
                        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                      }}
                      onPointerUp={(e) => {
                        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                        endDrag();
                      }}
                      onPointerCancel={(e) => {
                        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                        endDrag();
                      }}
                    >
                      <div
                        className={isSelected ? 'relative rounded-lg ring-2 ring-purple-400 ring-offset-2' : 'rounded-lg'}
                        style={{ padding: 4, background: isSelected ? 'rgba(255,255,255,0.55)' : 'transparent' }}
                      >
                        {isSelected && !isEditing && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              endDrag();
                              setTextLayers((prev) => prev.filter((t) => t.id !== layer.id));
                              setSelectedTextId((prev) => (prev === layer.id ? null : prev));
                              setEditingTextId((prev) => (prev === layer.id ? null : prev));
                            }}
                            className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-white border border-slate-200 shadow-sm text-slate-600 hover:text-red-600 hover:border-red-200 flex items-center justify-center"
                            title="Delete text"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <div
                          suppressContentEditableWarning
                          contentEditable={isEditing}
                          onBlur={(e) => {
                            const nextText = (e.currentTarget.textContent || '').trim() || 'Text';
                            setTextLayers((prev) =>
                              prev.map((t) => (t.id === layer.id ? { ...t, text: nextText } : t))
                            );
                            setEditingTextId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              (e.currentTarget as HTMLDivElement).blur();
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              (e.currentTarget as HTMLDivElement).blur();
                            }
                          }}
                          className={isEditing ? 'outline-none cursor-text' : 'cursor-move'}
                          ref={(node) => {
                            const map = textNodeRefs.current;
                            if (!node) {
                              map.delete(layer.id);
                              return;
                            }
                            map.set(layer.id, node);
                          }}
                          style={{
                            color: layer.color,
                            fontSize: `${Math.max(10, Math.round(layer.fontSize * display.scale))}px`,
                            fontFamily: fontCss,
                            lineHeight: 1.1,
                            textAlign: 'center',
                            userSelect: isEditing ? 'text' : 'none',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {layer.text}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      </main>

      <aside className="w-80 bg-white border-l border-slate-200 p-6 overflow-auto">
        <h4 className="text-slate-900 mb-4">Properties</h4>

        {!selectedText && !selectedLogo && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Select a text or logo layer to edit its properties.
          </div>
        )}

        {selectedText && (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500 mb-1">Selected</p>
              <p className="text-sm text-slate-900">Text</p>
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-3">Text Color</label>
              <div className="grid grid-cols-6 gap-2">
                {COLOR_SWATCHES.map((color) => {
                  const active = selectedText.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => {
                        setTextLayers((prev) =>
                          prev.map((t) => (t.id === selectedText.id ? { ...t, color } : t))
                        );
                      }}
                      className={`w-10 h-10 rounded-xl transition-all border-2 ${
                        active ? 'ring-4 ring-offset-2 ring-purple-500 border-white' : 'border-slate-200 hover:scale-110'
                      }`}
                      style={{ backgroundColor: color }}
                      title={color}
                    >
                      {color === '#FFFFFF' && <div className="w-full h-full border border-slate-300 rounded-xl" />}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500">Select text to change its color.</p>
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-2">Font Size</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={12}
                  max={160}
                  step={1}
                  value={selectedText.fontSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setTextLayers((prev) =>
                      prev.map((t) => (t.id === selectedText.id ? { ...t, fontSize: next } : t))
                    );
                  }}
                  className="flex-1"
                />
                <span className="text-xs text-slate-600 w-[44px] text-right">{selectedText.fontSize}px</span>
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-2">Font</label>
              <select
                value={selectedText.fontId}
                onChange={(e) => {
                  const next = e.target.value as TextFontId;
                  setTextLayers((prev) => prev.map((t) => (t.id === selectedText.id ? { ...t, fontId: next } : t)));
                }}
                className="w-full h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800"
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

          </div>
        )}

        <div className="mt-6 pt-6 border-t border-slate-200 space-y-3">
          <div>
            <h5 className="text-slate-900 font-medium">Save to My Designs</h5>
            <p className="text-xs text-slate-500">Enter a file name and save.</p>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-2">File name</label>
            <input
              ref={saveNameInputRef}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveToMyDesigns();
              }}
              placeholder="e.g., My edited design"
              className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
            />
          </div>

          <button
            type="button"
            disabled={saving}
            onClick={() => void saveToMyDesigns()}
            className={
              saving
                ? 'w-full px-4 py-2 rounded-xl bg-slate-200 text-slate-500 text-sm cursor-not-allowed'
                : 'w-full px-4 py-2 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 text-white text-sm hover:shadow-lg hover:shadow-purple-500/30'
            }
          >
            {saving ? 'Saving...' : 'Save to My Designs'}
          </button>
        </div>

        {selectedLogo && (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500 mb-1">Selected</p>
              <p className="text-sm text-slate-900">Logo</p>
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-2">Scale</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.1}
                  max={3}
                  step={0.01}
                  value={selectedLogo.scale}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setLogoLayers((prev) =>
                      prev.map((l) => (l.id === selectedLogo.id ? { ...l, scale: next } : l))
                    );
                  }}
                  className="flex-1"
                />
                <span className="text-xs text-slate-600 w-[44px] text-right">{selectedLogo.scale.toFixed(2)}x</span>
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-2">Rotation</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={selectedLogo.rotation}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setLogoLayers((prev) =>
                      prev.map((l) => (l.id === selectedLogo.id ? { ...l, rotation: next } : l))
                    );
                  }}
                  className="flex-1"
                />
                <span className="text-xs text-slate-600 w-[44px] text-right">{selectedLogo.rotation}°</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setLogoLayers((prev) => prev.filter((l) => l.id !== selectedLogo.id));
                setLogoDimsById((prev) => {
                  const next = { ...prev };
                  delete next[selectedLogo.id];
                  return next;
                });
                setSelectedLogoId(null);
              }}
              className="w-full h-[44px] rounded-xl border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 text-sm inline-flex items-center justify-center gap-2"
            >
              <X className="w-4 h-4" />
              Delete Logo
            </button>
          </div>
        )}
      </aside>

      {myDesignsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMyDesignsOpen(false)}
            aria-label="Close"
          />
          <div className="relative w-full max-w-3xl rounded-3xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-slate-900 font-medium">Select from My Designs</h3>
                <p className="text-xs text-slate-500">Choose a saved design as the base image.</p>
              </div>
              <button
                type="button"
                onClick={() => setMyDesignsOpen(false)}
                className="h-9 w-9 rounded-xl border border-slate-200 hover:bg-slate-50 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6">
              {designsLoading ? (
                <p className="text-sm text-slate-600">Loading...</p>
              ) : designsError ? (
                <p className="text-sm text-red-700">{designsError}</p>
              ) : designItems.length ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {designItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={async () => {
                        try {
                          let src = designThumbObjectUrls[item.id] || '';
                          if (!src) {
                            if (isApiFileUrl(item.thumbnail)) {
                              const objectUrl = await fetchAsObjectUrl(item.thumbnail);
                              if (objectUrl) {
                                setDesignThumbObjectUrls((prev) => ({ ...prev, [item.id]: objectUrl }));
                                src = objectUrl;
                              }
                            } else {
                              src = item.thumbnail;
                            }
                          }

                          if (!src) {
                            toast('Preview unavailable. Try again.');
                            return;
                          }

                          const prevPinned = pinnedBaseObjectUrlRef.current;
                          if (prevPinned && prevPinned !== src && prevPinned.startsWith('blob:')) {
                            URL.revokeObjectURL(prevPinned);
                          }
                          pinnedBaseObjectUrlRef.current = src.startsWith('blob:') ? src : null;
                          setBaseImageSrc(src);
                          clearSelection();
                          setMyDesignsOpen(false);
                        } catch {
                          toast('Failed to load design preview.');
                        }
                      }}
                      className="rounded-2xl border border-slate-200 overflow-hidden bg-white hover:border-purple-300 text-left"
                    >
                      <div className="aspect-square bg-slate-50">
                        <img
                          src={designThumbObjectUrls[item.id] || item.thumbnail}
                          alt={item.title}
                          className="w-full h-full object-contain"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src = placeholderThumb;
                          }}
                        />
                      </div>
                      <div className="p-3">
                        <p className="text-sm text-slate-900 truncate">{item.title}</p>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">No designs found.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
