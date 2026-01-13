import { useState, useRef, useEffect } from 'react';
import { Copy, Sparkles, Check } from 'lucide-react';
import { authFetch } from '../utils/auth';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area@1.2.3';

type Props = {
    onUseAsPrompt?: (value: string) => void;
};

export function ListingAssistantInline({ onUseAsPrompt }: Props) {
    const [titlesFieldText, setTitlesFieldText] = useState('');
    const [keywordsFieldText, setKeywordsFieldText] = useState('');
    const [titlesLastQuery, setTitlesLastQuery] = useState('');
    const [keywordsLastQuery, setKeywordsLastQuery] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [titles, setTitles] = useState<string[]>([]);
    const [keywords, setKeywords] = useState<string[]>([]);
    const [titlesLoading, setTitlesLoading] = useState(false);
    const [keywordsLoading, setKeywordsLoading] = useState(false);
    const [titlesCount, setTitlesCount] = useState<100 | 120>(120);
    const [keywordsCount, setKeywordsCount] = useState<300 | 350>(350);

    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const copiedTimerRef = useRef<number | null>(null);

    const normalizeQuery = (value: string) => (value || '').replace(/\s+/g, ' ').trim();
    const canOptimizeTitles = normalizeQuery(titlesFieldText).length > 0 || titlesLastQuery.length > 0;
    const canOptimizeKeywords = normalizeQuery(keywordsFieldText).length > 0 || keywordsLastQuery.length > 0;

    useEffect(() => {
        return () => {
            if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
        };
    }, []);

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
        const candidate = normalizeQuery(titlesFieldText);
        const looksLikeOutput = titles.length > 0 && normalizeQuery(titlesResultLimited) === candidate;
        const query = (looksLikeOutput ? titlesLastQuery : candidate).trim();

        if (!query) {
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
                    productName: query,
                    count: titlesCount,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to generate titles.');
            const list = Array.isArray(data?.titles) ? data.titles.filter((t: any) => typeof t === 'string') : [];
            if (list.length === 0) throw new Error('No titles returned.');
            setTitles(list.slice(0, titlesCount));
            setTitlesLastQuery(query);
        } catch (e: any) {
            setError(e?.message || 'Failed to generate titles.');
        } finally {
            setTitlesLoading(false);
        }
    };

    const generateKeywords = async () => {
        const candidate = normalizeQuery(keywordsFieldText);
        const looksLikeOutput = keywords.length > 0 && normalizeQuery(keywordsResultLimited) === candidate;
        const query = (looksLikeOutput ? keywordsLastQuery : candidate).trim();

        if (!query) {
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
                    productName: query,
                    count: keywordsCount,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to generate keywords.');
            const list = Array.isArray(data?.keywords) ? data.keywords.filter((t: any) => typeof t === 'string') : [];
            if (list.length === 0) throw new Error('No keywords returned.');
            setKeywords(list.slice(0, keywordsCount));
            setKeywordsLastQuery(query);
        } catch (e: any) {
            setError(e?.message || 'Failed to generate keywords.');
        } finally {
            setKeywordsLoading(false);
        }
    };

    const normalizeOneLine = (value: string) =>
        (value || '')
            .replace(/[\r\n\u2028\u2029]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const packItemsToRange = (items: string[], separator: string, minChars: number, maxChars: number) => {
        const normalized = items.map(normalizeOneLine).filter(Boolean);
        let out = '';
        for (const item of normalized) {
            const next = out ? `${out}${separator}${item}` : item;
            if (next.length <= maxChars) {
                out = next;
                continue;
            }

            // If we're still below minimum, fill remaining space by truncating the next item.
            if (out.length < minChars) {
                const remaining = maxChars - (out ? out.length + separator.length : 0);
                if (remaining > 0) {
                    const chunk = item.slice(0, remaining).trimEnd();
                    if (chunk) out = out ? `${out}${separator}${chunk}` : chunk;
                }
            }
        }

        // If still below minimum and we have some text, pad by repeating (then clamp).
        // This guarantees the displayed output stays within the requested char range.
        if (out.length > 0 && out.length < minChars) {
            while (out.length < minChars && out.length < maxChars) {
                const remaining = maxChars - out.length;
                const pad = (separator + out).slice(0, remaining);
                out += pad;
            }
        }

        if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
        return out;
    };

    // Keep outputs within requested character ranges whenever generated.
    const titlesResultLimited = packItemsToRange(titles, ' | ', 100, 120);
    const keywordsResultLimited = packItemsToRange(keywords, ', ', 300, 350);

    const calcChWidth = (value: string) => `${Math.min(600, Math.max(28, normalizeQuery(value).length + 2))}ch`;

    useEffect(() => {
        if (titlesResultLimited) setTitlesFieldText(titlesResultLimited);
    }, [titlesResultLimited]);

    useEffect(() => {
        if (keywordsResultLimited) setKeywordsFieldText(keywordsResultLimited);
    }, [keywordsResultLimited]);

	    return (
	        <div className="listing-assistant-inline bg-white rounded-3xl border border-slate-200 shadow-xl p-8 space-y-6">
	            <style>{`
	                @keyframes lai-shine {
	                    0% { transform: translate3d(-140%, 0, 0) skewX(-18deg); }
	                    100% { transform: translate3d(240%, 0, 0) skewX(-18deg); }
	                }
	                .listing-assistant-inline .lai-shimmer {
	                    position: relative;
	                    overflow: hidden;
	                }
	                .listing-assistant-inline .lai-shimmer::after {
	                    content: '';
	                    position: absolute;
	                    inset: -60% -40%;
	                    width: 55%;
	                    left: -60%;
	                    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.85), transparent);
	                    transform: translate3d(-140%, 0, 0) skewX(-18deg);
	                    opacity: 1;
	                    pointer-events: none;
	                    will-change: transform;
	                    animation: lai-shine 4s linear infinite;
	                }
	                @media (prefers-reduced-motion: reduce) {
	                    .listing-assistant-inline .lai-shimmer::after { animation-duration: 8s; }
	                }
	                .listing-assistant-inline .la-hscrollbar {
	                    display: flex;
	                    height: 10px;
	                    padding: 2px;
                }
                .listing-assistant-inline .la-hthumb {
                    flex: 1;
                    background: rgba(71, 85, 105, 0.9);
                    border-radius: 9999px;
                }
                .listing-assistant-inline .la-hthumb:hover {
                    background: rgba(51, 65, 85, 0.95);
                }
            `}</style>
		            <div className="flex items-center gap-3 mb-2">
		                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
		                    <Sparkles className="w-4 h-4 text-white" />
		                </div>
		                <div>
		                    <h3 className="text-lg font-semibold text-slate-900">AI Titles & Keywords</h3>
		                </div>
		            </div>

	    {error && <p className="text-sm text-red-600">{error}</p>}

	    {/* Results Section */}
	    <div className="space-y-4 pt-4 border-t border-slate-100">
	        {/* Titles Output (full width) */}
	        <div className="space-y-2">
	            <div className="flex items-center justify-between">
	                <div className="flex items-center gap-2">
	                    <label className="text-sm font-semibold text-slate-900">Generated Titles</label>
	                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
	                        {titlesResultLimited.length}/120
	                    </span>
	                </div>
	            </div>
		            <ScrollAreaPrimitive.Root type="always" className="w-full h-10 rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
		                <ScrollAreaPrimitive.Viewport className="h-full w-full whitespace-nowrap" style={{ whiteSpace: 'nowrap' }}>
		                    <div className="h-full px-3 py-2 flex items-center">
                                <input
                                    value={titlesFieldText}
                                    onChange={(e) => {
                                        setTitlesFieldText(e.target.value);
                                        if (titles.length) setTitles([]);
                                    }}
                                    placeholder="Type product name here..."
                                    className="bg-transparent border-0 p-0 m-0 shadow-none outline-none focus:outline-none focus:ring-0 focus:ring-offset-0 appearance-none text-[15px] text-slate-600 leading-6 min-w-max"
                                    style={{ width: calcChWidth(titlesFieldText) }}
                                />
		                    </div>
		                </ScrollAreaPrimitive.Viewport>
	                <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="la-hscrollbar">
	                    <ScrollAreaPrimitive.Thumb className="la-hthumb" />
	                </ScrollAreaPrimitive.Scrollbar>
	            </ScrollAreaPrimitive.Root>
	            <div className="flex items-center justify-between pt-1">
		                <button
		                    type="button"
		                    onClick={generateTitles}
		                    disabled={!canOptimizeTitles || titlesLoading}
		                    className="inline-flex items-center gap-2 text-sm font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-4 py-2 rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
		                >
		                    {titlesLoading ? 'Optimizing...' : 'Title optimization'}
		                </button>
	                {titles.length > 0 && (
	                    <button
                                onClick={() => copyText(titlesResultLimited, 'titles')}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors"
                                type="button"
                            >
                                {copiedKey === 'titles' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {copiedKey === 'titles' ? 'Copied' : 'Copy All'}
                            </button>
                        )}
                    </div>
                </div>

	        {/* Keywords Output (full width) */}
	        <div className="space-y-2">
	            <div className="flex items-center justify-between">
	                <div className="flex items-center gap-2">
	                    <label className="text-sm font-semibold text-slate-900">Generated Keywords</label>
	                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
	                        {keywordsResultLimited.length}/350
	                    </span>
	                </div>
	            </div>
		            <ScrollAreaPrimitive.Root type="always" className="w-full h-12 rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
		                <ScrollAreaPrimitive.Viewport className="h-full w-full whitespace-nowrap" style={{ whiteSpace: 'nowrap' }}>
		                    <div className="h-full px-3 py-2 flex items-center">
                                <input
                                    value={keywordsFieldText}
                                    onChange={(e) => {
                                        setKeywordsFieldText(e.target.value);
                                        if (keywords.length) setKeywords([]);
                                    }}
                                    placeholder="Type product name here..."
                                    className="bg-transparent border-0 p-0 m-0 shadow-none outline-none focus:outline-none focus:ring-0 focus:ring-offset-0 appearance-none text-[15px] text-slate-600 leading-6 min-w-max"
                                    style={{ width: calcChWidth(keywordsFieldText) }}
                                />
		                    </div>
		                </ScrollAreaPrimitive.Viewport>
	                <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="la-hscrollbar">
	                    <ScrollAreaPrimitive.Thumb className="la-hthumb" />
	                </ScrollAreaPrimitive.Scrollbar>
	            </ScrollAreaPrimitive.Root>
	            <div className="flex items-center justify-between pt-1">
		                <button
		                    type="button"
		                    onClick={generateKeywords}
		                    disabled={!canOptimizeKeywords || keywordsLoading}
		                    className="inline-flex items-center gap-2 text-sm font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-4 py-2 rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
		                >
		                    {keywordsLoading ? 'Expanding...' : 'Keywords expansion'}
		                </button>
	                {keywords.length > 0 && (
	                    <button
                                onClick={() => copyText(keywordsResultLimited, 'keywords')}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors"
                                type="button"
                            >
                                {copiedKey === 'keywords' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {copiedKey === 'keywords' ? 'Copied' : 'Copy All'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
