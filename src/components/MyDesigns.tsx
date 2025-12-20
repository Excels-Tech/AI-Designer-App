import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Image as ImageIcon, Trash2, Video as VideoIcon } from 'lucide-react';
import clsx from 'clsx';
import { authFetch, getUserId } from '../utils/auth';

type DesignListItem = {
  id: string;
  title: string;
  createdAt: string;
  style: string;
  resolution: number;
  views: string[];
  thumbnail: string;
};

type DesignDetail = {
  id: string;
  title: string;
  prompt: string;
  style: string;
  resolution: number;
  views: string[];
  composite: { mime: string; url?: string; dataUrl?: string };
  images: { view: string; mime: string; url?: string; dataUrl?: string }[];
  createdAt: string;
};

type VideoListItem = {
  id: string;
  title: string;
  createdAt: string;
};

export function MyDesigns() {
  const [designs, setDesigns] = useState<DesignListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [nextVideoCursor, setNextVideoCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [videosLoading, setVideosLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingVideo, setDeletingVideo] = useState<string | null>(null);
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [previewVideoLoading, setPreviewVideoLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [thumbObjectUrls, setThumbObjectUrls] = useState<Record<string, string>>({});
  const [detailObjectUrls, setDetailObjectUrls] = useState<Record<string, string>>({});

  const resolveSrc = (input?: { url?: string; dataUrl?: string } | string) => {
    if (!input) return '';
    if (typeof input === 'string') return input;
    return input.url || input.dataUrl || '';
  };

  const isApiFileUrl = (src: string) => src.startsWith('/api/files/');

  const fetchAsObjectUrl = async (src: string) => {
    const res = await authFetch(src);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load image.');
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  useEffect(() => {
    setUserId(getUserId());
  }, []);

  const fetchDesigns = async (cursor?: string) => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '24');
      if (cursor) params.set('cursor', cursor);
      const res = await authFetch(`/api/designs?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load designs.');
      }
      const data = await res.json();
      setDesigns((prev) => (cursor ? [...prev, ...(data.items || [])] : data.items || []));
      setNextCursor(data.nextCursor ?? null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load designs.');
    } finally {
      setLoading(false);
    }
  };

  const fetchVideos = async (cursor?: string) => {
    if (!userId) return;
    setVideosLoading(true);
    setVideoError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '24');
      if (cursor) params.set('cursor', cursor);
      const res = await authFetch(`/api/video-designs?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load videos.');
      }
      const data = await res.json();
      setVideos((prev) => (cursor ? [...prev, ...(data.items || [])] : data.items || []));
      setNextVideoCursor(data.nextCursor ?? null);
    } catch (err: any) {
      setVideoError(err?.message || 'Failed to load videos.');
    } finally {
      setVideosLoading(false);
    }
  };

  useEffect(() => {
    fetchDesigns();
    fetchVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const run = async () => {
      const toFetch = designs
        .filter((d) => isApiFileUrl(d.thumbnail) && !thumbObjectUrls[d.id])
        .map((d) => ({ id: d.id, url: d.thumbnail }));

      if (!toFetch.length) return;

      try {
        const entries = await Promise.all(
          toFetch.map(async (item) => {
            const objectUrl = await fetchAsObjectUrl(item.url);
            return [item.id, objectUrl] as const;
          })
        );
        if (cancelled) {
          entries.forEach(([, u]) => URL.revokeObjectURL(u));
          return;
        }
        setThumbObjectUrls((prev) => Object.fromEntries([...Object.entries(prev), ...entries]));
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load thumbnails', err);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, userId]);

  useEffect(() => {
    return () => {
      Object.values(thumbObjectUrls).forEach((u) => URL.revokeObjectURL(u));
      Object.values(detailObjectUrls).forEach((u) => URL.revokeObjectURL(u));
      if (previewVideoUrl) URL.revokeObjectURL(previewVideoUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDetail = async (id: string) => {
    if (!userId) return;
    setDetailLoading(true);
    setError(null);
    Object.values(detailObjectUrls).forEach((u) => URL.revokeObjectURL(u));
    setDetailObjectUrls({});
    try {
      const res = await authFetch(`/api/designs/${id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load design.');
      }
      const data = await res.json();
      setSelected(data);

      const urlsToFetch: Array<[string, string]> = [];
      const compositeSrc = resolveSrc(data.composite);
      if (isApiFileUrl(compositeSrc)) urlsToFetch.push(['composite', compositeSrc]);
      data.images.forEach((img: any) => {
        const src = resolveSrc(img);
        if (isApiFileUrl(src)) urlsToFetch.push([`view:${img.view}`, src]);
      });

      const fetched = await Promise.all(
        urlsToFetch.map(async ([key, src]) => [key, await fetchAsObjectUrl(src)] as const)
      );
      setDetailObjectUrls(Object.fromEntries(fetched));
    } catch (err: any) {
      setError(err?.message || 'Failed to load design.');
    } finally {
      setDetailLoading(false);
    }
  };

  const deleteDesign = async (id: string) => {
    if (!userId) return;
    setDeleting(id);
    setError(null);
    try {
      const res = await authFetch(`/api/designs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete design.');
      }
      setDesigns((prev) => prev.filter((d) => d.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete design.');
    } finally {
      setDeleting(null);
    }
  };

  const deleteVideo = async (id: string) => {
    if (!userId) return;
    setDeletingVideo(id);
    setVideoError(null);
    try {
      const res = await authFetch(`/api/video-designs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete video.');
      }
      setVideos((prev) => prev.filter((v) => v.id !== id));
    } catch (err: any) {
      setVideoError(err?.message || 'Failed to delete video.');
    } finally {
      setDeletingVideo(null);
    }
  };

  const downloading = (src: string, name: string) => {
    if (!src) return;
    if (isApiFileUrl(src)) {
      authFetch(src)
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Download failed.');
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = name;
          link.click();
          URL.revokeObjectURL(url);
        })
        .catch((err) => setError(err?.message || 'Download failed.'));
      return;
    }
    const link = document.createElement('a');
    link.href = src;
    link.download = name;
    link.click();
  };

  const downloadVideo = (id: string, title: string) => {
    const safe = (title || 'video').replace(/[^\w.\-]+/g, '_').slice(0, 60);
    authFetch(`/api/video-designs/${id}/download.mp4`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Download failed.');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${safe}-${id}.mp4`;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setVideoError(err?.message || 'Download failed.'));
  };

  const openVideoPreview = async (id: string) => {
    setVideoError(null);
    setPreviewVideoId(id);
    setPreviewVideoLoading(true);
    if (previewVideoUrl) {
      URL.revokeObjectURL(previewVideoUrl);
      setPreviewVideoUrl(null);
    }
    try {
      const res = await authFetch(`/api/video-designs/${id}/download.mp4`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load video.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreviewVideoUrl(url);
    } catch (err: any) {
      setVideoError(err?.message || 'Failed to load video.');
      setPreviewVideoId(null);
    } finally {
      setPreviewVideoLoading(false);
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-slate-900 text-xl">My Designs</h2>
          <p className="text-sm text-slate-600">Saved multi-view renders</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fetchDesigns()}
            className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
          >
            Refresh
          </button>
          {nextCursor && (
            <button
              onClick={() => fetchDesigns(nextCursor)}
              className="px-4 py-2 rounded-xl bg-purple-600 text-white text-sm hover:bg-purple-700"
            >
              Load More
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {videoError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4" />
          <span>{videoError}</span>
        </div>
      )}

      {loading && designs.length === 0 ? (
        !userId ? (
          <div className="rounded-2xl border border-slate-200 p-6 text-sm text-slate-600">
            Setting up user session...
          </div>
        ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="h-48 rounded-2xl bg-slate-100 animate-pulse" />
          ))}
        </div>
        )
      ) : designs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          No designs saved yet. Generate and click “Save to My Designs”.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {designs.map((design) => (
            <button
              key={design.id}
              onClick={() => openDetail(design.id)}
              className="group rounded-2xl border border-slate-200 hover:border-purple-400 hover:shadow-lg transition-all overflow-hidden text-left"
            >
              <div className="aspect-square bg-slate-100 relative">
                {resolveSrc(design.thumbnail) ? (
                  <img
                    src={thumbObjectUrls[design.id] || resolveSrc(design.thumbnail)}
                    alt={design.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                    <ImageIcon className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div className="p-3 space-y-1">
                <p className="text-sm text-slate-900 line-clamp-1">{design.title || 'Untitled Design'}</p>
                <p className="text-xs text-slate-500">
                  {design.views.length} views · {design.resolution}x{design.resolution}
                </p>
                <p className="text-[11px] text-slate-500 uppercase tracking-wide">{design.style}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="pt-8 border-t border-slate-200 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-slate-900 text-lg">My Videos</h3>
            <p className="text-sm text-slate-600">Saved video exports</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => fetchVideos()}
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
            >
              Refresh
            </button>
            {nextVideoCursor && (
              <button
                onClick={() => fetchVideos(nextVideoCursor)}
                className="px-4 py-2 rounded-xl bg-purple-600 text-white text-sm hover:bg-purple-700"
              >
                Load More
              </button>
            )}
          </div>
        </div>

        {previewVideoId && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <VideoIcon className="h-4 w-4 text-slate-600" />
                Video Preview
              </div>
              <button
                type="button"
                onClick={() => setPreviewVideoId(null)}
                className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
              >
                Close
              </button>
            </div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-900">
              {previewVideoLoading ? (
                <div className="h-[280px] flex items-center justify-center text-slate-200">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="ml-2 text-sm">Loading video...</span>
                </div>
              ) : previewVideoUrl ? (
                <video controls preload="metadata" className="w-full max-h-[520px]" src={previewVideoUrl} />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-slate-200 text-sm">
                  Video not available.
                </div>
              )}
            </div>
          </div>
        )}

        {videosLoading && videos.length === 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, idx) => (
              <div key={idx} className="h-40 rounded-2xl bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
            No videos saved yet. Export an MP4 and click “Save to My Designs”.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {videos.map((video) => (
              <div
                key={video.id}
                className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center">
                    <VideoIcon className="h-5 w-5 text-slate-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-900 font-medium truncate">{video.title}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(video.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => openVideoPreview(video.id)}
                    className="flex-1 px-3 py-2 rounded-xl bg-white border border-slate-200 hover:border-purple-300 text-sm text-slate-800"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadVideo(video.id, video.title)}
                    className="flex-1 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
                  >
                    Download MP4
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteVideo(video.id)}
                    disabled={deletingVideo === video.id}
                    className={clsx(
                      'px-3 py-2 rounded-xl text-sm inline-flex items-center justify-center',
                      deletingVideo === video.id
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                        : 'bg-red-50 text-red-700 hover:bg-red-100'
                    )}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="rounded-3xl border border-slate-200 bg-white shadow-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-slate-900 text-lg">{selected.title || 'Untitled Design'}</h3>
              <p className="text-sm text-slate-600">
                {selected.views.length} views · {selected.resolution}x{selected.resolution} · {selected.style}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  downloading(
                    detailObjectUrls.composite || resolveSrc(selected.composite),
                    `${selected.id}-composite.png`
                  )
                }
                className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-800"
              >
                Download Composite
              </button>
              <button
                onClick={() => deleteDesign(selected.id)}
                disabled={deleting === selected.id}
                className={clsx(
                  'px-3 py-2 rounded-xl text-sm flex items-center gap-1',
                  deleting === selected.id ? 'bg-slate-200 text-slate-500' : 'bg-red-50 text-red-700 hover:bg-red-100'
                )}
              >
                <Trash2 className="w-4 h-4" />
                {deleting === selected.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-900">
            <img
              src={detailObjectUrls.composite || resolveSrc(selected.composite)}
              alt="Composite"
              className="w-full h-full object-contain max-h-[480px]"
            />
          </div>

          <div>
            <p className="text-sm text-slate-700 mb-2">Cropped Views</p>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
              {selected.images.map((img) => (
                <div key={img.view} className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50 shadow-sm">
                  <div className="aspect-square bg-white">
                    <img
                      src={detailObjectUrls[`view:${img.view}`] || resolveSrc(img)}
                      alt={img.view}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-3 flex items-center justify-between text-sm">
                    <span className="text-slate-800">{img.view}</span>
                    <button
                      onClick={() =>
                        downloading(
                          detailObjectUrls[`view:${img.view}`] || resolveSrc(img),
                          `${selected.id}-${img.view}.png`
                        )
                      }
                      className="text-purple-600 text-xs hover:underline"
                    >
                      Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {detailLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading design...
        </div>
      )}
    </div>
  );
}
