import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { AIImageGenerator } from './components/AIImageGenerator';
import { DesignEditor } from './components/DesignEditor';
import { ProductMockup } from './components/ProductMockup';
import { VideoCreator } from './components/VideoCreator';
import { MyDesigns } from './components/MyDesigns';

export type Screen = 
  | 'dashboard' 
  | 'ai-generator' 
  | 'my-designs' 
  | 'editor' 
  | 'product-preview' 
  | 'video-creator' 
  | 'settings';

export type WorkflowStep = 'generate' | 'preview' | 'crop' | 'edit' | 'product' | 'video';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('dashboard');
  const [croppedImages, setCroppedImages] = useState<string[]>([]);
  const [editedDesign, setEditedDesign] = useState<string | null>(null);
  const handleDesignComplete = (designUrl: string) => {
    setEditedDesign(designUrl);
  };

  const renderContent = () => {
    // Workflow screens
    if (currentScreen === 'ai-generator') {
      return <AIImageGenerator />;
    }

    // Individual screens
    switch (currentScreen) {
      case 'dashboard':
        return <Dashboard onNavigate={setCurrentScreen} />;
      case 'editor':
        return (
          <DesignEditor
            baseImages={croppedImages}
            onComplete={handleDesignComplete}
          />
        );
      case 'product-preview':
        return (
          <ProductMockup
            designUrl={editedDesign}
            onCreateVideo={() => {
              setCurrentScreen('video-creator');
            }}
          />
        );
      case 'video-creator':
        return <VideoCreator designUrl={editedDesign} />;
      case 'my-designs':
        return <MyDesigns />;
      case 'settings':
        return <Dashboard onNavigate={setCurrentScreen} />;
      default:
        return <Dashboard onNavigate={setCurrentScreen} />;
    }
  };

  return (
    <div className="flex h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 overflow-hidden">
      <Sidebar
        currentScreen={currentScreen}
        onNavigate={(screen) => {
          setCurrentScreen(screen);
        }}
      />
      <main className="flex-1 overflow-auto">
        {renderContent()}
      </main>
    </div>
  );
}
