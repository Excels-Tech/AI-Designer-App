import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type RightSidePanelProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  headerLeft?: ReactNode;
  children: ReactNode;
};

export function RightSidePanel({ open, title, subtitle, onClose, headerLeft, children }: RightSidePanelProps) {
  if (!open) return null;

  return (
    <aside
      // Use inline positioning so the panel never falls back to in-flow layout.
      style={{
        position: 'fixed',
        right: '24px',
        top: '112px',
        bottom: '24px',
        width: 'min(420px, calc(100vw - 2rem))',
        zIndex: 1000,
      }}
      className="bg-white border border-slate-200 rounded-3xl shadow-2xl shadow-slate-900/10 flex flex-col"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {headerLeft}
            <p className="text-slate-900 font-medium truncate">{title}</p>
          </div>
          {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-200 p-2 text-slate-700 hover:bg-slate-100"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </aside>
  );
}
