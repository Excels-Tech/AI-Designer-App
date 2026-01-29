import { useState, useRef, useEffect } from 'react';
import { Copy, Sparkles, Check } from 'lucide-react';
import { authFetch } from '../utils/auth';

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
    const [titlesText, setTitlesText] = useState('');
    const [keywordsText, setKeywordsText] = useState('');
    const [titlesDirty, setTitlesDirty] = useState(false);
    const [titlesLoading, setTitlesLoading] = useState(false);
    const [keywordsLoading, setKeywordsLoading] = useState(false);
    const [titlesCount, setTitlesCount] = useState<number>(15);
    const [keywordsCount, setKeywordsCount] = useState<number>(80);

    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const copiedTimerRef = useRef<number | null>(null);

    const normalizeQuery = (value: string) => (value || '').replace(/\s+/g, ' ').trim();
    const canOptimizeTitles =
        normalizeQuery(titlesFieldText).length > 0 ||
        normalizeQuery(titlesLastQuery).length > 0 ||
        normalizeQuery(titlesText).length > 0;
    const canOptimizeKeywords =
        normalizeQuery(keywordsFieldText).length > 0 ||
        normalizeQuery(keywordsLastQuery).length > 0 ||
        normalizeQuery(keywordsText).length > 0;

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

    // Parse titles from raw response into line candidates. We intentionally do NOT split on pipes, to avoid
    // accidentally breaking valid titles into fragments that then get padded into long garbage output.
    const parseTitles = (raw: string): string[] => {
        const normalized = String(raw || '')
            // Insert line breaks before inline numbering like "1) Title 2) Title"
            .replace(/\s+(\d+[.)]\s+)/g, '\n$1');

        return normalized
            .split(/\r?\n/)
            .flatMap((line) => line.split(/•/))
            .map((line) => line.trim())
            .filter(Boolean);
    };

    function normalizeTitle(title: string): string {
        return String(title || '')
            .replace(/\s+/g, ' ')
            .replace(/^[\d\W]+/, '')
            .trim();
    }

    function enforceTotalLength(text: string, min = 100, max = 120): string {
        let t = String(text || '').replace(/\s+/g, ' ').trim();

        if (t.length > max) {
            t = t.slice(0, max);
            t = t.replace(/\s+\S*$/, ''); // word boundary
            t = t.replace(/[,\-—:;.|]+$/, '').trim();
        }

        const fillers = [' Premium Gift', ' Collector Edition', ' High Detail', ' Limited Release'];
        let i = 0;
        while (t.length < min && i < fillers.length) {
            if (t.length + fillers[i].length <= max) t += fillers[i];
            i += 1;
        }
        while (t.length < min && t.length + 8 <= max) t += ' Premium';

        return t.trim();
    }

    function normalizeKeywords(raw: string): string {
        return String(raw || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/,/g, ' ')
            .replace(/[•|·]/g, ' ')
            .replace(/\b\d+[\).\]]\s*/g, '')
            .replace(/[^a-zA-Z0-9\s-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function enforceKeywordLength(text: string, min = 300, max = 350): string {
        let t = normalizeKeywords(text);

        if (t.length > max) {
            t = t.slice(0, max);
            t = t.replace(/\s+\S*$/, '').trim();
        }

        if (t.length < min) {
            const words = t.split(' ').filter(Boolean);
            let i = 0;
            while (t.length < min && words.length) {
                const w = words[i % Math.min(words.length, 8)];
                if (t.length + 1 + w.length > max) break;
                t += ` ${w}`;
                i += 1;
            }
        }

        return t.replace(/\s+/g, ' ').trim();
    }



    const generateTitles = async () => {
        const candidate = normalizeQuery(titlesFieldText) || normalizeQuery(titlesText);
        const query = candidate || titlesLastQuery;

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
                    count: 10,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to generate titles.');

            const raw =
                Array.isArray(data?.titles)
                    ? data.titles.filter((t: any) => typeof t === 'string').join('\n')
                    : typeof data?.titles === 'string'
                      ? data.titles
                      : '';
            if (!raw.trim()) throw new Error('No titles returned.');

            const parsed = parseTitles(raw)
                .map((t) => normalizeTitle(t))
                .filter(Boolean);
            if (!parsed.length) throw new Error('No titles returned.');

            // Select a single best title then hard-enforce TOTAL length 100-120 chars.
            const inRange = parsed.filter((t) => t.length >= 100 && t.length <= 120);
            const bestTitle = (inRange.sort((a, b) => b.length - a.length)[0] ?? parsed[0]) || '';
            const finalTitle = enforceTotalLength(bestTitle, 100, 120);

            if (finalTitle.length < 100 || finalTitle.length > 120) {
                throw new Error('Could not produce a title within 100-120 characters.');
            }

            setTitles([finalTitle]);
            setTitlesText(finalTitle);
            setTitlesDirty(false);
            setTitlesLastQuery(query);
        } catch (e: any) {
            setError(e?.message || 'Failed to generate titles.');
        } finally {
            setTitlesLoading(false);
        }
    };

    const generateKeywords = async () => {
        const candidate = normalizeQuery(keywordsFieldText) || normalizeQuery(keywordsText);
        // Use candidate first; fallback to last query for regeneration if input is hidden/empty.
        const query = candidate || keywordsLastQuery;

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
            const trimmed = list.slice(0, keywordsCount);
            const finalKeywords = enforceKeywordLength(trimmed.join(' '), 300, 350);
            if (finalKeywords.length < 300 || finalKeywords.length > 350) {
                throw new Error('Could not produce keywords within 300-350 characters.');
            }
            setKeywords(trimmed);
            setKeywordsText(finalKeywords);
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

    const stripDanglingTitleTail = (title: string) => {
        let s = normalizeOneLine(title).replace(/[|,;:\-–—]+$/g, '').trimEnd();
        const badEnd = new Set(['and', 'or', 'for', 'with', 'to', 'in', 'of', 'the', 'a', 'an']);
        for (let i = 0; i < 4; i += 1) {
            const m = /(\s+)([A-Za-z]+)\s*$/.exec(s);
            if (!m) break;
            const word = (m[2] || '').toLowerCase();
            if (!badEnd.has(word)) break;
            s = s.slice(0, m.index).replace(/[|,;:\-–—]+$/g, '').trimEnd();
        }
        return s;
    };



    const packItemsToLimitNoPartial = (items: string[], separator: string, maxChars: number) => {
        const normalized = items.map(normalizeOneLine).filter(Boolean);
        let out = '';
        for (const item of normalized) {
            const next = out ? `${out}${separator}${item}` : item;
            if (next.length > maxChars) break; // never cut inside an item
            out = next;
        }
        return out.trimEnd();
    };

    const packItemsToRange = (
        items: string[],
        separator: string,
        minChars: number,
        maxChars: number,
        preferMaxChars: number = maxChars
    ) => {
        const truncateAtWordBoundary = (text: string, limit: number) => {
            const t = normalizeOneLine(text);
            if (t.length <= limit) return t;
            const cut = t.slice(0, limit);
            const lastSpace = cut.lastIndexOf(' ');
            const lastSep = Math.max(cut.lastIndexOf(','), cut.lastIndexOf('|'));
            const idx = Math.max(lastSpace, lastSep);
            const safe = (idx > 0 ? cut.slice(0, idx) : cut).trimEnd();
            return safe.replace(/[|,]\s*$/g, '').trimEnd();
        };

        const normalized = items.map(normalizeOneLine).filter(Boolean);
        let out = '';
        const effectiveMax = Math.max(minChars, Math.min(maxChars, preferMaxChars));
        for (const item of normalized) {
            const next = out ? `${out}${separator}${item}` : item;
            if (next.length <= effectiveMax) {
                out = next;
                continue;
            }

            // If we're still below minimum, fill remaining space by truncating the next item.
            if (out.length < minChars) {
                const remaining = effectiveMax - (out ? out.length + separator.length : 0);
                if (remaining > 0) {
                    const chunk = truncateAtWordBoundary(item, remaining);
                    if (chunk) out = out ? `${out}${separator}${chunk}` : chunk;
                }
            }
        }

        if (out.length > effectiveMax) out = truncateAtWordBoundary(out, effectiveMax);
        // Do NOT pad by repeating; prefer a shorter, complete-word output.
        return out.replace(/\s+/g, ' ').trimEnd();
    };

    // Keep outputs within requested character ranges whenever generated.
    const cleanPunctuation = (s: string) => s.replace(/[|,;:!]/g, ' ').replace(/\s+/g, ' ').trim();

    const titlesCharCount = titlesText.length;
    const keywordsCharCount = keywordsText.length;
    const keywordsBadges = keywords.map(cleanPunctuation).filter(Boolean);
    const keywordsResultLimited = keywordsText || keywordsBadges.join(' ');

    const calcChWidth = (value: string) => `${Math.min(600, Math.max(28, normalizeQuery(value).length + 2))}ch`;

    useEffect(() => {
        if (titles.length) setTitlesFieldText('');
    }, [titles]);

    useEffect(() => {
        if (keywords.length) setKeywordsFieldText('');
    }, [keywords]);

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
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-semibold text-slate-900">Generated Titles</label>
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                    {titlesCharCount}/120
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={generateTitles}
                                disabled={titlesLoading || !canOptimizeTitles}
                                className="inline-flex items-center gap-2 text-sm font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-4 py-2 rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {titlesLoading ? 'Generating...' : 'Generate Titles'}
                            </button>
                        </div>
                    </div>
                    <div className="relative w-full">
                        <div className="relative w-full rounded-xl border border-slate-200 bg-white">
                            <textarea
                                value={titlesText}
                                onChange={(e) => {
                                    setTitlesDirty(true);
                                    setTitlesText(e.target.value);
                                }}
                                placeholder="Generated titles will appear here (editable)..."
                                className="w-full resize-y border-0 bg-transparent px-3 pr-16 py-3 text-sm text-slate-800 focus:outline-none focus:ring-0"
                                rows={3}
                            />
                            {titlesText.trim().length > 0 && (
                                <button
                                    onClick={() => copyText(titlesText, 'titles')}
                                    className="absolute top-2 right-2 left-auto z-10 inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors"
                                    type="button"
                                >
                                    {copiedKey === 'titles' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                    {copiedKey === 'titles' ? 'Copied' : 'Copy'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Keywords Output - Badges */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <label className="text-sm font-semibold text-slate-900">Generated Keywords</label>
                            <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                {keywordsCharCount}/350
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={generateKeywords}
                                disabled={keywordsLoading || !canOptimizeKeywords}
                                className="inline-flex items-center gap-2 text-sm font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-4 py-2 rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {keywordsLoading ? 'Generating...' : 'Generate Keywords'}
                            </button>
                        </div>
                    </div>
                    <div className="relative w-full">
                        <div className="relative w-full rounded-xl border border-slate-200 bg-white">
                        <textarea
                            value={keywordsText}
                            onChange={(e) => setKeywordsText(e.target.value)}
                            placeholder="Generated keywords will appear here (editable)..."
                            className="w-full resize-y border-0 bg-transparent px-3 pr-16 py-3 text-sm text-slate-800 focus:outline-none focus:ring-0"
                            rows={2}
                        />
                        {keywordsText.trim().length > 0 && (
                            <button
                                type="button"
                                className="absolute top-2 right-2 left-auto z-10 inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors"
                                onClick={() => copyText(keywordsText || keywordsResultLimited, 'keywords')}
                            >
                                {copiedKey === 'keywords' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {copiedKey === 'keywords' ? 'Copied' : 'Copy'}
                            </button>
                        )}
                        </div>
                    </div>
                </div>
            </div>
        </div >
    );
}
