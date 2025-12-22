import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { authFetch, getUserId } from '../../utils/auth';
import { DesignsGrid, type DesignCardItem } from '../video-creator/DesignsGrid';

type RightDrawerMyDesignsProps = {
  open: boolean;
  onClose: () => void;
  selectedDesignId: string | null;
  onSelectDesign: (item: DesignCardItem) => void;
};

type ApiDesignListItem = { id: string; title?: string; name?: string; thumbnail: string };

const isApiFileUrl = (src: string) => src.startsWith('/api/files/');

const toVideoFilesUrl = (url: string) => (isApiFileUrl(url) ? `/api/video/files/${url.slice('/api/files/'.length)}` : url);

const withUid = (url: string) => {
  if (!url) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!parsed.pathname.startsWith('/api/')) return url;
    parsed.searchParams.set('uid', getUserId());
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    if (!url.startsWith('/api/')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}uid=${encodeURIComponent(getUserId())}`;
  }
};

export function RightDrawerMyDesigns({ open, onClose, selectedDesignId, onSelectDesign }: RightDrawerMyDesignsProps) {
  const [items, setItems] = useState<DesignCardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const loadPage = async (cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', '24');
    if (cursor) params.set('cursor', cursor);

    const res = await authFetch(`/api/designs?${params.toString()}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load designs.');
    }
    const data = await res.json();
    const next = (data.items || []) as ApiDesignListItem[];
    const mapped = next
      .filter((d) => d && typeof d.id === 'string')
      .map((d) => ({
        id: d.id,
        title: d.title || d.name || 'Untitled Design',
        thumbnail: withUid(toVideoFilesUrl(d.thumbnail || '')),
      }))
      .filter((d) => Boolean(d.thumbnail));

    setItems((prev) => (cursor ? [...prev, ...mapped] : mapped));
    setNextCursor(data.nextCursor ?? null);
  };

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setQuery('');
    setItems([]);
    setNextCursor(null);

    loadPage()
      .catch((err) => {
        setError(err?.message || 'Failed to load designs.');
        setItems([]);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filteredDesigns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => (item.title || '').toLowerCase().includes(q));
  }, [items, query]);

  if (!open) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-4 border-b border-slate-200">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search designs..."
          className="w-full px-3 py-2 rounded-xl border border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-5">
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
        ) : (
          <>
            <DesignsGrid items={filteredDesigns} selectedId={selectedDesignId} onSelect={onSelectDesign} />
            {nextCursor && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  setError(null);
                  loadPage(nextCursor)
                    .catch((err) => setError(err?.message || 'Failed to load designs.'))
                    .finally(() => setLoadingMore(false));
                }}
                className="mt-4 w-full px-4 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800 disabled:opacity-60"
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
