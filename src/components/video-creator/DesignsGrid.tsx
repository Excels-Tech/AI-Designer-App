import clsx from 'clsx';

export type DesignCardItem = {
  id: string;
  title: string;
  thumbnail: string;
};

type DesignsGridProps = {
  items: DesignCardItem[];
  selectedId: string | null;
  onSelect: (item: DesignCardItem) => void;
};

export function DesignsGrid({ items, selectedId, onSelect }: DesignsGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => {
        const active = selectedId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className={clsx(
              'rounded-2xl border-2 text-left transition-all overflow-hidden bg-white',
              active ? 'border-purple-500 ring-2 ring-purple-200' : 'border-slate-200 hover:border-slate-300'
            )}
          >
            <div className="aspect-square bg-slate-100">
              <img src={item.thumbnail} alt={item.title} className="h-full w-full object-cover" />
            </div>
            <div className="px-3 py-2">
              <p className="text-xs text-slate-800 line-clamp-1">{item.title}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

