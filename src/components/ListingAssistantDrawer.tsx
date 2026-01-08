import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { authFetch } from '../utils/auth';

type Props = {
  open: boolean;
  onClose: () => void;
  onUseAsPrompt?: (value: string) => void;
};

export function ListingAssistantDrawer({ open, onClose, onUseAsPrompt }: Props) {
  const [productName, setProductName] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(false);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [titlesCount, setTitlesCount] = useState<50 | 80 | 100 | 120>(120);
  const [keywordsCount, setKeywordsCount] = useState<100 | 200 | 300 | 350>(350);

  const copiedTimerRef = useRef<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const canGenerate = useMemo(() => productName.trim().length > 0, [productName]);
  const generateDisabled = !canGenerate || titlesLoading || keywordsLoading;

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    setCopiedKey(null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (!open) return null;

  const showCopied = (key: string) => {
    setCopiedKey(key);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1200);
  };

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showCopied(key);
    } catch {
      // fallback
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showCopied(key);
    }
  };

  const generateTitles = async () => {
    if (!canGenerate) {
      setError('Product name is required.');
      return;
    }
    setError(null);
    setTitlesLoading(true);
    try {
      const res = await authFetch('/api/generate-product-titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: productName.trim(),
          category: category.trim() || undefined,
          count: titlesCount,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to generate titles.');
      const list = Array.isArray(data?.titles) ? data.titles.filter((t: any) => typeof t === 'string') : [];
      if (list.length === 0) throw new Error('No titles returned.');
      setTitles(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to generate titles.');
    } finally {
      setTitlesLoading(false);
    }
  };

  const generateKeywords = async () => {
    if (!canGenerate) {
      setError('Product name is required.');
      return;
    }
    setError(null);
    setKeywordsLoading(true);
    try {
      const res = await authFetch('/api/generate-product-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: productName.trim(),
          category: category.trim() || undefined,
          count: keywordsCount,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to generate keywords.');
      const list = Array.isArray(data?.keywords) ? data.keywords.filter((t: any) => typeof t === 'string') : [];
      if (list.length === 0) throw new Error('No keywords returned.');
      setKeywords(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to generate keywords.');
    } finally {
      setKeywordsLoading(false);
    }
  };

  const generateBoth = async () => {
    await Promise.all([generateTitles(), generateKeywords()]);
  };

  const content = (
    <div
      className="fixed inset-0 z-[2147483647]"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483647 }}
      role="dialog"
      aria-modal="true"
      aria-label="AI Titles & Keywords"
    >
      <button
        type="button"
        className="fixed inset-0 bg-black/40"
        style={{ position: 'fixed', inset: 0, zIndex: 2147483646 }}
        aria-label="Close drawer overlay"
        onClick={onClose}
      />

      <div
        className={clsx(
          'listing-assistant-drawer fixed inset-y-0 right-0 w-[420px] max-w-[92vw] bg-white shadow-2xl',
          'border-l border-slate-200 h-screen flex flex-col'
        )}
        style={{ position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 2147483647 }}
      >
        <style>{`
          /* Drawer-only results scrollbar styling */
          .listing-assistant-drawer .lad-scrollbar {
            scrollbar-gutter: stable;
            scrollbar-width: auto; /* Firefox */
            scrollbar-color: rgb(168, 85, 247) rgb(241, 245, 249); /* thumb track */
          }
          .listing-assistant-drawer .lad-scrollbar::-webkit-scrollbar {
            width: 12px;
          }
          .listing-assistant-drawer .lad-scrollbar::-webkit-scrollbar-track {
            background: rgb(203, 213, 225); /* slate-300 - visibly dark for debug */
            border-radius: 6px;
          }
          .listing-assistant-drawer .lad-scrollbar::-webkit-scrollbar-thumb {
            background: rgb(168, 85, 247);
            border-radius: 6px;
            border: 3px solid rgb(248, 250, 252);
          }
          .listing-assistant-drawer .lad-scrollbar::-webkit-scrollbar-thumb:hover {
            background: rgb(147, 51, 234);
          }

          /* Custom scrollbars for individual sections */
          .listing-assistant-drawer .scrollbar-thin {
            scrollbar-width: thin; /* Firefox */
            scrollbar-color: rgb(168, 85, 247) rgb(226, 232, 240); /* purple-500 and slate-200 */
          }
          .listing-assistant-drawer .scrollbar-thin::-webkit-scrollbar {
            width: 6px;
          }
          .listing-assistant-drawer .scrollbar-thin::-webkit-scrollbar-track {
            background: rgb(226, 232, 240);
            border-radius: 3px;
          }
          .listing-assistant-drawer .scrollbar-thin::-webkit-scrollbar-thumb {
            background: rgb(168, 85, 247);
            border-radius: 3px;
          }
          .listing-assistant-drawer .scrollbar-thin::-webkit-scrollbar-thumb:hover {
            background: rgb(147, 51, 234);
          }
        `}</style>

        <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900 truncate">AI Titles &amp; Keywords</h2>
            <p className="text-xs text-slate-500 mt-1">Generate SEO listing content using your Gemini key.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-600"
            aria-label="Close"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div
          className="flex flex-col flex-1 min-h-0 lad-scrollbar"
          style={{ overflowY: 'scroll' }}
        >
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Product name</label>
              <input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. T-shirt"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400"
              />
            </div>

            <div>
              <label className="block text-sm text-slate-700 mb-1">Category (optional)</label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Sportswear"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Titles count</label>
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={titlesCount}
                  onChange={(e) => setTitlesCount(Number(e.target.value) as any)}
                >
                  <option value={50}>50</option>
                  <option value={80}>80</option>
                  <option value={100}>100</option>
                  <option value={120}>120</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Keywords count</label>
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={keywordsCount}
                  onChange={(e) => setKeywordsCount(Number(e.target.value) as any)}
                >
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={300}>300</option>
                  <option value={350}>350</option>
                </select>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-bold px-4 py-2 rounded-lg shadow-lg transition-all"
                onClick={generateTitles}
              >
                {titlesLoading ? 'Generating...' : 'Generate Titles'}
              </button>
              <button
                type="button"
                className="bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white font-bold px-4 py-2 rounded-lg shadow-lg transition-all"
                onClick={generateKeywords}
              >
                {keywordsLoading ? 'Generating...' : 'Generate Keywords'}
              </button>
            </div>

            <button
              type="button"
              disabled={generateDisabled}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={generateBoth}
            >
              {titlesLoading || keywordsLoading ? 'Generating...' : 'Generate Both'}
            </button>

            {onUseAsPrompt && (
              <button
                type="button"
                disabled={!canGenerate}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={() => onUseAsPrompt(productName.trim())}
              >
                Use product name as prompt
              </button>
            )}
          </div>

          <div className="results-scroll-area pb-4">
            <div className="px-4 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">Generated Titles</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600">{titles.length}</span>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60"
                      disabled={titles.length === 0}
                      onClick={() => copyText(titles.join('\n'), 'titles:all')}
                    >
                      {copiedKey === 'titles:all' ? 'Copied' : 'Copy All'}
                    </button>
                  </div>
                </div>
                <div className="mt-2 space-y-2 pr-2 scrollbar-thin" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                  {titles.map((t, idx) => (
                    <div key={`${idx}-${t}`} className="rounded-lg border border-slate-200 bg-white p-2">
                      <div className="text-xs text-slate-900 whitespace-normal break-words leading-snug">{t}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded-lg border border-slate-200 hover:bg-slate-50"
                          onClick={() => copyText(t, `title:${idx}`)}
                        >
                          {copiedKey === `title:${idx}` ? 'Copied' : 'Copy'}
                        </button>
                        {onUseAsPrompt && (
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded-lg border border-slate-200 hover:bg-slate-50"
                            onClick={() => onUseAsPrompt(t)}
                          >
                            Use as Prompt
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {titles.length === 0 && (
                    <div className="text-xs text-slate-500 py-6 text-center">No titles generated yet.</div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">Generated Keywords</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600">{keywords.length}</span>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60"
                      disabled={keywords.length === 0}
                      onClick={() => copyText(keywords.join('\n'), 'keywords:all')}
                    >
                      {copiedKey === 'keywords:all' ? 'Copied' : 'Copy All'}
                    </button>
                  </div>
                </div>
                <div className="mt-2 space-y-2 pr-2 scrollbar-thin" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                  {keywords.map((k, idx) => (
                    <div
                      key={`${idx}-${k}`}
                      className="rounded-lg border border-slate-200 bg-white p-2 flex items-center justify-between gap-2"
                    >
                      <div className="text-xs text-slate-900 whitespace-normal break-words leading-snug">{k}</div>
                      <button
                        type="button"
                        className="text-xs px-2 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 shrink-0"
                        onClick={() => copyText(k, `kw:${idx}`)}
                      >
                        {copiedKey === `kw:${idx}` ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                  {keywords.length === 0 && (
                    <div className="text-xs text-slate-500 py-6 text-center">No keywords generated yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // Render in a portal so `position: fixed` always anchors to the viewport (avoids parent transform/layout issues).
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
