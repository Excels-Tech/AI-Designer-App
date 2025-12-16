import { useState } from 'react';
import { Video, Play, Download, Type, Sparkles, Settings, Plus, X, ChevronLeft, ChevronRight } from 'lucide-react';

interface VideoCreatorProps {
  designUrl: string | null;
}

interface ImageSlide {
  id: string;
  imageUrl: string;
  text: string;
  fontSize: number;
  fontStyle: string;
  textPosition: 'top' | 'center' | 'bottom';
  animation: string;
  duration: number;
}

const animationStyles = [
  { id: 'fade', label: 'Fade In', icon: '✨' },
  { id: 'slide', label: 'Slide', icon: '➡️' },
  { id: 'zoom', label: 'Zoom', icon: '🔍' },
  { id: 'rotate', label: 'Rotate', icon: '🔄' },
];

const fontStyles = [
  { id: 'modern', label: 'Modern', sample: 'Aa' },
  { id: 'classic', label: 'Classic', sample: 'Aa' },
  { id: 'bold', label: 'Bold', sample: 'Aa' },
  { id: 'script', label: 'Script', sample: 'Aa' },
];

export function VideoCreator({ designUrl }: VideoCreatorProps) {
  const [slides, setSlides] = useState<ImageSlide[]>([
    {
      id: '1',
      imageUrl: designUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&h=800&fit=crop',
      text: 'Front View',
      fontSize: 48,
      fontStyle: 'modern',
      textPosition: 'bottom',
      animation: 'fade',
      duration: 3,
    },
    {
      id: '2',
      imageUrl: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=1200&h=800&fit=crop',
      text: 'Back View',
      fontSize: 48,
      fontStyle: 'modern',
      textPosition: 'bottom',
      animation: 'slide',
      duration: 3,
    },
    {
      id: '3',
      imageUrl: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1200&h=800&fit=crop',
      text: 'Side View',
      fontSize: 48,
      fontStyle: 'modern',
      textPosition: 'bottom',
      animation: 'zoom',
      duration: 3,
    },
  ]);

  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoQuality, setVideoQuality] = useState('1080p');
  const [videoFormat, setVideoFormat] = useState('mp4');

  const currentSlide = slides[currentSlideIndex];
  const totalDuration = slides.reduce((acc, slide) => acc + slide.duration, 0);

  const updateSlide = (id: string, updates: Partial<ImageSlide>) => {
    setSlides(slides.map(slide => 
      slide.id === id ? { ...slide, ...updates } : slide
    ));
  };

  const addSlide = () => {
    const newSlide: ImageSlide = {
      id: Date.now().toString(),
      imageUrl: 'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=1200&h=800&fit=crop',
      text: 'New Slide',
      fontSize: 48,
      fontStyle: 'modern',
      textPosition: 'center',
      animation: 'fade',
      duration: 3,
    };
    setSlides([...slides, newSlide]);
  };

  const removeSlide = (id: string) => {
    if (slides.length > 1) {
      setSlides(slides.filter(slide => slide.id !== id));
      if (currentSlideIndex >= slides.length - 1) {
        setCurrentSlideIndex(Math.max(0, slides.length - 2));
      }
    }
  };

  const handleExport = () => {
    alert(`Video exported successfully!\n\nSettings:\n- ${slides.length} images\n- Total duration: ${totalDuration}s\n- Quality: ${videoQuality}\n- Format: ${videoFormat.toUpperCase()}`);
  };

  const nextSlide = () => {
    setCurrentSlideIndex((prev) => (prev + 1) % slides.length);
  };

  const prevSlide = () => {
    setCurrentSlideIndex((prev) => (prev - 1 + slides.length) % slides.length);
  };

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                  <Video className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-slate-900">Multi-Image Video Creator</h2>
              </div>
              <p className="text-slate-600">Create engaging videos from your design images with custom text overlays</p>
            </div>
            <button
              onClick={handleExport}
              className="px-6 py-2 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl hover:shadow-xl hover:shadow-purple-500/30 transition-all flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              <span className="text-sm">Export Video ({videoFormat.toUpperCase()})</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Slide List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-slate-900">Slides ({slides.length})</h4>
                <button
                  onClick={addSlide}
                  className="w-8 h-8 rounded-lg bg-purple-500 text-white flex items-center justify-center hover:bg-purple-600 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 mb-6">
                {slides.map((slide, index) => (
                  <div
                    key={slide.id}
                    onClick={() => setCurrentSlideIndex(index)}
                    className={`relative group cursor-pointer rounded-xl overflow-hidden border-2 transition-all ${
                      currentSlideIndex === index
                        ? 'border-purple-500 shadow-lg'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="aspect-video bg-slate-100">
                      <img
                        src={slide.imageUrl}
                        alt={`Slide ${index + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex flex-col justify-end p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-white text-xs block">Slide {index + 1}</span>
                          <span className="text-white/80 text-xs">{slide.duration}s</span>
                        </div>
                        {slides.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSlide(slide.id);
                            }}
                            className="w-6 h-6 rounded-lg bg-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="w-3 h-3 text-white" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Video Settings */}
              <div className="pt-6 border-t border-slate-200 space-y-4">
                <div>
                  <label className="block text-sm text-slate-700 mb-2">Video Quality</label>
                  <select 
                    value={videoQuality}
                    onChange={(e) => setVideoQuality(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  >
                    <option>720p HD</option>
                    <option>1080p Full HD</option>
                    <option>4K Ultra HD</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-slate-700 mb-2">Format</label>
                  <select
                    value={videoFormat}
                    onChange={(e) => setVideoFormat(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  >
                    <option value="mp4">MP4</option>
                    <option value="mov">MOV</option>
                    <option value="webm">WebM</option>
                  </select>
                </div>

                <div className="pt-4 border-t border-slate-200">
                  <div className="text-sm text-slate-600 space-y-1">
                    <div className="flex justify-between">
                      <span>Total Duration:</span>
                      <span className="text-slate-900">{totalDuration}s</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Frame Rate:</span>
                      <span className="text-slate-900">30 FPS</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Preview & Editor */}
          <div className="lg:col-span-3 space-y-6">
            {/* Video Preview */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
              <div className="p-4 border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Video className="w-5 h-5 text-slate-600" />
                    <span className="text-sm text-slate-700">Preview - Slide {currentSlideIndex + 1} of {slides.length}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={prevSlide}
                      className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4 text-slate-700" />
                    </button>
                    <button
                      onClick={nextSlide}
                      className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
                    >
                      <ChevronRight className="w-4 h-4 text-slate-700" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="aspect-video bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center relative">
                <img
                  src={currentSlide.imageUrl}
                  alt="Video preview"
                  className="w-full h-full object-contain"
                />
                
                {/* Text Overlay Preview */}
                {currentSlide.text && (
                  <div className={`absolute inset-0 flex items-${currentSlide.textPosition === 'top' ? 'start' : currentSlide.textPosition === 'bottom' ? 'end' : 'center'} justify-center p-12`}>
                    <div className="bg-black/40 backdrop-blur-sm px-8 py-4 rounded-2xl">
                      <p
                        className="text-white text-center"
                        style={{ fontSize: `${currentSlide.fontSize}px` }}
                      >
                        {currentSlide.text}
                      </p>
                    </div>
                  </div>
                )}

                {/* Play Button */}
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors group"
                >
                  <div className="w-20 h-20 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center group-hover:scale-110 transition-transform shadow-2xl">
                    <Play className="w-8 h-8 text-slate-900 ml-1" />
                  </div>
                </button>

                {/* Animation Badge */}
                <div className="absolute top-4 right-4 px-3 py-1 bg-black/60 backdrop-blur-sm rounded-lg">
                  <span className="text-xs text-white">
                    {animationStyles.find(a => a.id === currentSlide.animation)?.label}
                  </span>
                </div>
              </div>

              {/* Timeline */}
              <div className="p-6 border-t border-slate-200">
                <div className="mb-4">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-slate-600">Timeline</span>
                    <span className="text-slate-900">
                      {slides.slice(0, currentSlideIndex + 1).reduce((acc, s) => acc + s.duration, 0)}s / {totalDuration}s
                    </span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden flex">
                    {slides.map((slide, index) => (
                      <div
                        key={slide.id}
                        className={`h-full transition-all ${
                          index === currentSlideIndex
                            ? 'bg-gradient-to-r from-violet-500 to-purple-500'
                            : index < currentSlideIndex
                            ? 'bg-purple-300'
                            : 'bg-slate-200'
                        }`}
                        style={{ width: `${(slide.duration / totalDuration) * 100}%` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Current Slide Editor */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
              <div className="flex items-center gap-2 mb-6">
                <Type className="w-5 h-5 text-slate-600" />
                <h4 className="text-slate-900">Edit Slide {currentSlideIndex + 1}</h4>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Text Input */}
                <div className="md:col-span-2">
                  <label className="block text-sm text-slate-700 mb-3">Text Overlay</label>
                  <input
                    type="text"
                    value={currentSlide.text}
                    onChange={(e) => updateSlide(currentSlide.id, { text: e.target.value })}
                    placeholder="Enter text for this slide..."
                    className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-purple-500 focus:outline-none text-sm"
                  />
                </div>

                {/* Font Style */}
                <div>
                  <label className="block text-sm text-slate-700 mb-3">Font Style</label>
                  <div className="grid grid-cols-2 gap-2">
                    {fontStyles.map((font) => (
                      <button
                        key={font.id}
                        onClick={() => updateSlide(currentSlide.id, { fontStyle: font.id })}
                        className={`p-3 rounded-xl border-2 transition-all ${
                          currentSlide.fontStyle === font.id
                            ? 'border-purple-500 bg-purple-50'
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="text-xl mb-1">{font.sample}</div>
                        <div className="text-xs text-slate-600">{font.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Animation */}
                <div>
                  <label className="block text-sm text-slate-700 mb-3">Animation</label>
                  <div className="grid grid-cols-2 gap-2">
                    {animationStyles.map((animation) => (
                      <button
                        key={animation.id}
                        onClick={() => updateSlide(currentSlide.id, { animation: animation.id })}
                        className={`p-3 rounded-xl border-2 transition-all text-left ${
                          currentSlide.animation === animation.id
                            ? 'border-purple-500 bg-purple-50'
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{animation.icon}</span>
                          <span className="text-xs text-slate-900">{animation.label}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Font Size */}
                <div>
                  <label className="block text-sm text-slate-700 mb-3">Font Size</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="24"
                      max="72"
                      value={currentSlide.fontSize}
                      onChange={(e) => updateSlide(currentSlide.id, { fontSize: Number(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-sm text-slate-600 w-12">{currentSlide.fontSize}px</span>
                  </div>
                </div>

                {/* Text Position */}
                <div>
                  <label className="block text-sm text-slate-700 mb-3">Text Position</label>
                  <div className="grid grid-cols-3 gap-2">
                    {['top', 'center', 'bottom'].map((position) => (
                      <button
                        key={position}
                        onClick={() => updateSlide(currentSlide.id, { textPosition: position as any })}
                        className={`px-4 py-2 rounded-xl text-sm transition-all capitalize ${
                          currentSlide.textPosition === position
                            ? 'bg-purple-500 text-white'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {position}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Duration */}
                <div className="md:col-span-2">
                  <label className="block text-sm text-slate-700 mb-3">Slide Duration</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="2"
                      max="10"
                      value={currentSlide.duration}
                      onChange={(e) => updateSlide(currentSlide.id, { duration: Number(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-sm text-slate-600 w-12">{currentSlide.duration}s</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
