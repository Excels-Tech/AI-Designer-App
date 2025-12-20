import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Image as ImageIcon, Loader2, AlertTriangle, X } from 'lucide-react';
import { authFetch, getUserId, resolveApiAssetUrl } from '../../utils/auth';

type DesignListItem = {
  id: string;
  title: string;
  thumbnail: string;
};

type AssetPickerProps = {
  open: boolean;
  maxSelect: number;
  initialDesignId?: string | null;
  variant?: 'drawer' | 'panel';
  appearance?: 'card' | 'embedded';
  onClose: () => void;
  onAdd: (items: { url: string; label: string }[]) => void;
};

const isApiFileUrl = (src: string) => src.startsWith('/api/files/');

export function AssetPicker({
  open,
  maxSelect,
  initialDesignId = null,
  variant = 'drawer',
  appearance = 'card',
  onClose,
  onAdd,
}: AssetPickerProps) {
  const [designs, setDesigns] = useState<DesignListItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeDesignId, setActiveDesignId] = useState<string | null>(null);
  const [variantsByDesign, setVariantsByDesign] = useState<Record<string, Array<{ key: string; url: string; label: string }>>>(
    {}
  );
  const [variantIndex, setVariantIndex] = useState<Record<string, { url: string; label: string }>>({});
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = useMemo(() => getUserId(), []);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setError(null);
    setLoading(true);
    setActiveDesignId(null);
    setVariantsByDesign({});
    setVariantIndex({});

    authFetch('/api/designs?limit=24')
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load designs.');
        }
        const data = await res.json();
        const items = data.items || [];
        setDesigns(items);
        const preferred = initialDesignId && items.some((item: any) => item?.id === initialDesignId) ? initialDesignId : null;
        setActiveDesignId(preferred || items[0]?.id || null);
      })
      .catch((err) => setError(err?.message || 'Failed to load designs.'))
      .finally(() => setLoading(false));
  }, [initialDesignId, open, userId]);

  const withUid = (url: string) => {
    const resolved = resolveApiAssetUrl(url);
    if (/[?&]uid=/i.test(resolved)) return resolved;
    try {
      const parsed = new URL(resolved, window.location.origin);
      if (!parsed.pathname.startsWith('/api/')) return resolved;
      parsed.searchParams.set('uid', userId);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      if (!resolved.startsWith('/api/')) return resolved;
      const sep = resolved.includes('?') ? '&' : '?';
      return `${resolved}${sep}uid=${encodeURIComponent(userId)}`;
    }
  };

  const toVideoFilesUrl = (url: string) => {
    if (!isApiFileUrl(url)) return url;
    return `/api/video/files/${url.slice('/api/files/'.length)}`;
  };

  useEffect(() => {
    if (!open) return;
    if (!activeDesignId) return;
    if (variantsByDesign[activeDesignId]) return;
    setVariantsLoading(true);
    setError(null);
    authFetch(`/api/designs/${activeDesignId}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to fetch design.');
        }
        const data = await res.json();
        const title = designs.find((d) => d.id === activeDesignId)?.title || data?.title || 'Design';
        const nextVariants: Array<{ key: string; url: string; label: string }> = [];

        const compositeUrl = typeof data?.composite?.url === 'string' ? data.composite.url : '';
        if (compositeUrl && isApiFileUrl(compositeUrl)) {
          const key = `${activeDesignId}:composite`;
          nextVariants.push({
            key,
            url: withUid(toVideoFilesUrl(compositeUrl)),
            label: `${title} (Full)`,
          });
        }

        const images = Array.isArray(data?.images) ? data.images : [];
        images.forEach((img: any, idx: number) => {
          const url = typeof img?.url === 'string' ? img.url : '';
          if (!url || !isApiFileUrl(url)) return;
          const view = typeof img?.view === 'string' && img.view ? img.view : `Image ${idx + 1}`;
          const key = `${activeDesignId}:${view}:${idx}`;
          nextVariants.push({
            key,
            url: withUid(toVideoFilesUrl(url)),
            label: `${title} (${view})`,
          });
        });

        if (!nextVariants.length) {
          throw new Error('Design image is missing.');
        }

        setVariantsByDesign((prev) => ({ ...prev, [activeDesignId]: nextVariants }));
        setVariantIndex((prev) => ({
          ...prev,
          ...Object.fromEntries(nextVariants.map((v) => [v.key, { url: v.url, label: v.label }])),
        }));
      })
      .catch((err) => setError(err?.message || 'Failed to load design.'))
      .finally(() => setVariantsLoading(false));
  }, [activeDesignId, designs, open, userId, variantsByDesign]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < maxSelect) {
        next.add(key);
      }
      return next;
    });
  };

  const handleAdd = async () => {
    setError(null);
    try {
      const payload = Array.from(selected)
        .map((key) => variantIndex[key])
        .filter(Boolean)
        .map((item) => ({ url: item.url, label: item.label }));
      if (!payload.length) {
        throw new Error('No assets selected.');
      }
      onAdd(payload);
      if (variant !== 'panel') {
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to add designs.');
    }
  };

  if (!open) return null;

  const gridLayoutClass =
    variant === 'panel' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 lg:grid-cols-2 gap-6';

  const containerClass =
    appearance === 'embedded'
      ? 'h-full bg-white overflow-hidden flex flex-col'
      : 'h-full rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden flex flex-col';

  const headerClass = appearance === 'embedded' ? 'border-b border-slate-200 px-5 py-4' : 'border-b border-slate-200 px-6 py-4';
  const bodyClass = appearance === 'embedded' ? 'p-5 flex-1 overflow-auto' : 'p-6 flex-1 overflow-auto';
  const footerClass = appearance === 'embedded' ? 'border-t border-slate-200 px-5 py-4' : 'border-t border-slate-200 px-6 py-4';

  const content = (
    <div className={containerClass}>
      <div className={`flex items-center justify-between ${headerClass}`}>
        <div>
          <h3 className="text-slate-900">Add from My Designs</h3>
          <p className="text-sm text-slate-500">Select up to {maxSelect} assets to add as slides.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 inline-flex items-center gap-2"
        >
          <X className="h-4 w-4" />
          Close
        </button>
      </div>

      <div className={bodyClass}>
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading designs...
          </div>
        ) : designs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">
            No saved designs yet.
          </div>
        ) : (
          <div className={gridLayoutClass}>
            <div className="space-y-3">
              {designs.map((design) => {
                const isActive = activeDesignId === design.id;
                const thumb =
                  design.thumbnail && isApiFileUrl(design.thumbnail) ? toVideoFilesUrl(design.thumbnail) : '';
                return (
                  <button
                    key={design.id}
                    type="button"
                    onClick={() => setActiveDesignId(design.id)}
                    className={`w-full flex items-center gap-3 rounded-2xl border-2 p-3 text-left transition-all ${
                      isActive ? 'border-purple-500 bg-purple-50' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="h-14 w-14 rounded-xl bg-slate-100 overflow-hidden flex items-center justify-center">
                      {thumb ? (
                        <img src={withUid(thumb)} alt={design.title} className="h-full w-full object-cover" />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-slate-400" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-slate-900 line-clamp-1">{design.title || 'Untitled Design'}</p>
                      <p className="text-xs text-slate-500">Pick images from this design</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              {!activeDesignId ? (
                <div className="text-sm text-slate-500">Select a design to view its images.</div>
              ) : variantsLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading design images...
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {(variantsByDesign[activeDesignId] || []).map((variant) => {
                    const isSelected = selected.has(variant.key);
                    return (
                      <button
                        key={variant.key}
                        type="button"
                        onClick={() => toggle(variant.key)}
                        className={`group rounded-2xl border-2 text-left transition-all ${
                          isSelected
                            ? 'border-purple-500 ring-2 ring-purple-200'
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="aspect-square bg-slate-100 rounded-xl overflow-hidden relative">
                          <img src={variant.url} alt={variant.label} className="h-full w-full object-cover" />
                          {isSelected && (
                            <div className="absolute top-2 right-2 rounded-full bg-purple-500 text-white p-1">
                              <CheckSquare className="h-4 w-4" />
                            </div>
                          )}
                        </div>
                        <div className="px-3 py-2">
                          <p className="text-xs text-slate-700 line-clamp-1">{variant.label}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={`flex items-center justify-between ${footerClass}`}>
        <p className="text-xs text-slate-500">{selected.size} selected</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={handleAdd}
            className="rounded-xl bg-purple-500 px-4 py-2 text-sm text-white hover:bg-purple-600 disabled:opacity-50"
          >
            Add Selected
          </button>
        </div>
      </div>
    </div>
  );

  if (variant === 'panel') return content;

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute right-0 top-0 h-full w-full max-w-2xl bg-white shadow-2xl p-4">{content}</div>
    </div>
  );
}

