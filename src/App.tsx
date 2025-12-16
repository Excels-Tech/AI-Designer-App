import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { AIImageGenerator, GenerateRequest } from './components/AIImageGenerator';
import { MultiViewPreview } from './components/MultiViewPreview';
import { CropAssets } from './components/CropAssets';
import { DesignEditor } from './components/DesignEditor';
import { ProductMockup } from './components/ProductMockup';
import { VideoCreator } from './components/VideoCreator';
import { MyDesigns } from './components/MyDesigns';
import type { SavedDesign, ViewId } from './services/designStore';
import { addVersion as addVersionApi, createDesign as createDesignApi, getDesign } from './services/designApi';

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
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('generate');
  const [generatedResult, setGeneratedResult] = useState<any | null>(null);
  const [lastRequest, setLastRequest] = useState<GenerateRequest | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [croppedImages, setCroppedImages] = useState<string[]>([]);
  const [editedDesign, setEditedDesign] = useState<string | null>(null);
  const [activeDesignId, setActiveDesignId] = useState<string | null>(null);

  const handleGenerateImage = (result: any, request: GenerateRequest) => {
    setGeneratedResult(result);
    setLastRequest(request);
    setWorkflowStep('preview');
    setActiveDesignId(null);
  };

  const handleCropComplete = (images: string[]) => {
    setCroppedImages(images);
    setWorkflowStep('edit');
    setCurrentScreen('editor');
  };

  const handleDesignComplete = (designUrl: string) => {
    setEditedDesign(designUrl);
    setWorkflowStep('product');
    setCurrentScreen('product-preview');
  };

  const handleOpenDesign = async (design: SavedDesign) => {
    const full = (design as any).versions ? (design as any) : await getDesign(design.designId);
    const latestVersion = full.versions[0];
    const request: GenerateRequest = {
      prompt: latestVersion.prompt,
      style: latestVersion.style as any,
      resolution: latestVersion.resolution as GenerateRequest['resolution'],
      views: (latestVersion as any).views as ViewId[],
    };
    setLastRequest(request);
    setGeneratedResult({
      combinedImage: latestVersion.combinedImage,
      views: latestVersion.crops.map((c) => ({ view: c.view, image: c.dataUrl })),
      meta: {
        baseView: latestVersion.crops[0]?.view as ViewId,
        style: latestVersion.style,
        resolution: latestVersion.resolution,
      },
    });
    setActiveDesignId(full.designId);
    setWorkflowStep('preview');
    setCurrentScreen('ai-generator');
  };

  const handleSaveVersion = async () => {
    if (!generatedResult || !lastRequest) {
      throw new Error('Nothing to save yet');
    }
    const payload = {
      title: lastRequest.prompt.split(' ').slice(0, 6).join(' ') || 'Untitled Design',
      prompt: lastRequest.prompt,
      style: lastRequest.style,
      resolution: lastRequest.resolution,
      format: 'png',
      quality: 'max',
      combinedImage: generatedResult.combinedImage,
      views: generatedResult.views.map((v: any) => ({ view: v.view, image: v.image })),
    };
    if (activeDesignId) {
      const updated = await addVersionApi(activeDesignId, payload);
      setActiveDesignId(updated.designId);
      return updated;
    }
    const created = await createDesignApi(payload);
    setActiveDesignId(created.designId);
    return created;
  };

  const renderContent = () => {
    // Workflow screens
    if (currentScreen === 'ai-generator') {
      if (workflowStep === 'generate') {
        return <AIImageGenerator onGenerate={handleGenerateImage} />;
      } else if (workflowStep === 'preview' && generatedResult) {
        return (
          <MultiViewPreview
            result={generatedResult}
            request={lastRequest}
            isRegenerating={isRegenerating}
            errorMessage={regenerateError || undefined}
            onRegenerate={async () => {
              if (!lastRequest) return;
              try {
                setIsRegenerating(true);
                setRegenerateError(null);
                const res = await fetch('/api/generate-image', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(lastRequest),
                });
                const raw = await res.text();
                let data: any = null;
                try {
                  data = JSON.parse(raw);
                } catch {
                  data = null;
                }
                if (!res.ok) {
                  throw new Error(data?.error || raw || 'Server error');
                }
                setGeneratedResult(data);
              } catch (err) {
                setRegenerateError((err as Error).message);
              } finally {
                setIsRegenerating(false);
              }
            }}
            onSaveVersion={handleSaveVersion}
            onCropStart={() => setWorkflowStep('crop')}
            onBack={() => setWorkflowStep('generate')}
          />
        );
      } else if (workflowStep === 'crop' && generatedResult) {
        return (
          <CropAssets
            result={generatedResult}
            request={lastRequest}
            onDesignSaved={(designId) => setActiveDesignId(designId)}
            onComplete={handleCropComplete}
            onBack={() => setWorkflowStep('preview')}
          />
        );
      }
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
              setWorkflowStep('video');
              setCurrentScreen('video-creator');
            }}
          />
        );
      case 'video-creator':
        return <VideoCreator designUrl={editedDesign || generatedResult?.combinedImage} />;
      case 'my-designs':
        return <MyDesigns onOpenDesign={handleOpenDesign} />;
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
          if (screen === 'ai-generator') {
            setWorkflowStep('generate');
          }
        }}
      />
      <main className="flex-1 overflow-auto">
        {renderContent()}
      </main>
    </div>
  );
}
