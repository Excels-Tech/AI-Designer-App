import { useEffect, useState } from 'react';
import { Trash2, Download, ExternalLink } from 'lucide-react';
import { deleteDesign as deleteDesignApi, getDesign, listDesigns } from '../services/designApi';
import type { SavedDesign } from '../services/designStore';

interface MyDesignsProps {
  onOpenDesign?: (design: SavedDesign) => void;
}

export function MyDesigns({ onOpenDesign }: MyDesignsProps) {
  const [items, setItems] = useState<
    { designId: string; title: string; updatedAt: string; combinedImageUrl: string | null; versionCount: number }[]
  >([]);

  useEffect(() => {
    const refresh = async () => {
      const data = await listDesigns();
      setItems(data);
    };
    refresh();
  }, []);

  const handleDelete = async (id: string) => {
    await deleteDesignApi(id);
    const data = await listDesigns();
    setItems(data);
  };

  const handleDownload = async (designId: string) => {
    const design = await getDesign(designId);
    const latest = design.versions[0];
    const link = document.createElement('a');
    link.href = latest.combinedImage;
    link.download = `${design.title || design.designId}_${latest.resolution}.${latest.format}`;
    link.click();
  };

  if (items.length === 0) {
    return (
      <div className="p-8">
        <h2 className="text-slate-900 mb-2">My Designs</h2>
        <p className="text-slate-600">No saved versions yet.</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="text-slate-900 mb-4">My Designs</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {items.map((item) => (
          <div key={item.designId} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="aspect-[4/3] bg-slate-100">
              <img
                src={item.combinedImageUrl || ''}
                alt={item.title}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-900 text-sm">{item.title}</p>
                  <p className="text-xs text-slate-500">
                    Updated {new Date(item.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDownload(item.designId)}
                    className="text-slate-400 hover:text-slate-700"
                    title="Download"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(item.designId)}
                    className="text-slate-400 hover:text-rose-500"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-slate-600">Versions: {item.versionCount}</p>
              {onOpenDesign && (
                <div className="space-y-1">
                  <button
                    onClick={async () => {
                      const design = await getDesign(item.designId);
                      onOpenDesign({ ...design, designId: item.designId } as any);
                    }}
                    className="text-sm text-purple-600 hover:text-purple-700 flex items-center gap-1"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open Latest
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
