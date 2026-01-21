import { Plus, Image, FileText, Palette, Package, Video, ArrowRight, Clock } from 'lucide-react';
import type { Screen } from '../App';

interface DashboardProps {
  onNavigate: (screen: Screen) => void;
}

const recentProjects = [
  { id: 1, name: 'Summer Collection Tee', type: 'Product Design', date: '2 hours ago', thumbnail: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&h=300&fit=crop' },
  { id: 2, name: 'Brand Logo Animation', type: 'Video', date: '5 hours ago', thumbnail: 'https://images.unsplash.com/photo-1626785774573-4b799315345d?w=400&h=300&fit=crop' },
  { id: 3, name: 'Product Mockup Series', type: 'Mockup', date: '1 day ago', thumbnail: 'https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?w=400&h=300&fit=crop' },
  { id: 4, name: 'Abstract Art Design', type: 'AI Generated', date: '2 days ago', thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&h=300&fit=crop' },
  { id: 5, name: 'Fashion Lookbook', type: 'Product Design', date: '3 days ago', thumbnail: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=400&h=300&fit=crop' },
  { id: 6, name: 'Marketing Video', type: 'Video', date: '4 days ago', thumbnail: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=400&h=300&fit=crop' },
];

const quickActions = [
  { id: 'ai-generator' as Screen, icon: Image, label: 'AI Product Generator', description: 'Generate product visuals from prompts', gradient: 'from-violet-500 to-purple-500' },
  { id: 'ai-image-generator' as Screen, icon: Image, label: 'AI Image Generator', description: 'Social Media Designer presets + live preview', gradient: 'from-violet-500 to-purple-500' },
  { id: 'ai-stationery' as Screen, icon: FileText, label: 'AI Stationery Designer', description: 'Generate catalog, letterhead, card, logo & more', gradient: 'from-violet-500 to-purple-500' },
  { id: 'editor' as Screen, icon: Palette, label: 'Edit Design', description: 'Layer-based design editor', gradient: 'from-blue-500 to-cyan-500' },
  { id: 'product-preview' as Screen, icon: Package, label: 'Product Mockup', description: 'Preview on real products', gradient: 'from-pink-500 to-rose-500' },
  { id: 'video-creator' as Screen, icon: Video, label: 'Create Video', description: 'Transform images to videos', gradient: 'from-amber-500 to-orange-500' },
];

export function Dashboard({ onNavigate }: DashboardProps) {
  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-slate-900 mb-2">Welcome back, Creator 👋</h2>
        <p className="text-slate-600">Let's create something amazing today</p>
      </div>

      {/* Create New Design CTA */}
      <div className="app-shimmer-sweep mb-12 bg-gradient-to-br from-violet-500 via-purple-500 to-fuchsia-500 rounded-3xl p-8 text-white shadow-2xl shadow-purple-500/30 relative overflow-hidden">
        <div className="app-shimmer-bg absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS1vcGFjaXR5PSIwLjA3IiBzdHJva2Utd2lkdGg9IjEiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] opacity-50"></div>
        <div className="relative z-10">
          <h3 className="mb-2">Start Your Creative Journey</h3>
          <p className="text-purple-100 mb-6">Generate AI images, edit designs, create mockups, and convert to videos</p>
          <button
            onClick={() => onNavigate('ai-generator')}
            className="bg-white text-purple-600 px-6 py-3 rounded-xl hover:shadow-xl transition-all duration-200 flex items-center gap-2 group"
          >
            <Plus className="w-5 h-5" />
            <span>Create New Design</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mb-12">
        <h3 className="text-slate-900 mb-6">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                onClick={() => onNavigate(action.id)}
                className="p-6 bg-white rounded-2xl border border-slate-200 hover:border-transparent hover:shadow-xl transition-all duration-200 text-left group"
              >
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${action.gradient} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h4 className="text-slate-900 mb-1">{action.label}</h4>
                <p className="text-sm text-slate-500">{action.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Recent Projects */}
      <div>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-slate-900">Recent Projects</h3>
          <button className="text-sm text-purple-600 hover:text-purple-700 flex items-center gap-1">
            View all
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {recentProjects.map((project) => (
            <div
              key={project.id}
              className="bg-white rounded-2xl border border-slate-200 overflow-hidden hover:shadow-xl transition-all duration-200 group cursor-pointer"
            >
              <div className="aspect-[4/3] bg-slate-100 overflow-hidden">
                <img
                  src={project.thumbnail}
                  alt={project.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </div>
              <div className="p-4">
                <h4 className="text-slate-900 mb-1">{project.name}</h4>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">{project.type}</span>
                  <span className="text-slate-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {project.date}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
