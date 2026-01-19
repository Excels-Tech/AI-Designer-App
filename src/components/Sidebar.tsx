import { 
  LayoutDashboard, 
  Sparkles, 
  FolderOpen, 
  Palette, 
  Package, 
  Video, 
  Settings 
} from 'lucide-react';
import type { Screen } from '../App';

interface SidebarProps {
  currentScreen: Screen;
  onNavigate: (screen: Screen) => void;
}

const navItems = [
  { id: 'dashboard' as Screen, icon: LayoutDashboard, label: 'Dashboard' },
  { id: 'ai-generator' as Screen, icon: Sparkles, label: 'AI Product Generator' },
  { id: 'ai-image-generator' as Screen, icon: Sparkles, label: 'AI Image Generator' },
  { id: 'my-designs' as Screen, icon: FolderOpen, label: 'My Designs' },
  { id: 'editor' as Screen, icon: Palette, label: 'Editor' },
  { id: 'product-preview' as Screen, icon: Package, label: 'Product Preview' },
  { id: 'video-creator' as Screen, icon: Video, label: 'Video Creator' },
];

export function Sidebar({ currentScreen, onNavigate }: SidebarProps) {
  return (
    <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="app-shimmer-sweep w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-slate-900">AI Designer</h1>
            <p className="text-xs text-slate-500">Create & Design</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentScreen === item.id;
          
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`
                w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200
                ${isActive 
                  ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-purple-500/30' 
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }
              `}
            >
              <Icon className="w-5 h-5" />
              <span className="text-sm">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Settings */}
      <div className="p-4 border-t border-slate-200">
        <button
          onClick={() => onNavigate('settings')}
          className={`
            w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200
            ${currentScreen === 'settings'
              ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-purple-500/30'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }
          `}
        >
          <Settings className="w-5 h-5" />
          <span className="text-sm">Settings</span>
        </button>
      </div>
    </aside>
  );
}
