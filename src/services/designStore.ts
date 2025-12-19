export type ViewId = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'top';

export type DesignVersion = {
  versionId: string;
  createdAt: string;
  combinedImage: string;
  crops: Array<{ view: ViewId | string; dataUrl: string }>;
  format: 'png' | 'jpg' | 'webp';
  quality: 'max' | 'high' | 'medium';
  resolution: number;
  views: ViewId[];
  style: 'realistic' | '3d' | 'lineart' | 'watercolor';
  prompt: string;
};

export type SavedDesign = {
  designId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  versions: DesignVersion[];
};

export const KEY = 'ai_designer_my_designs_v1';
export const DESIGN_STORE_EVENT = 'ai-designer-designs-updated';

function safeParse(value: string | null): SavedDesign[] {
  if (!value) return [];
  try {
    const data = JSON.parse(value);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeDesign);
  } catch {
    return [];
  }
}

function load(): SavedDesign[] {
  return safeParse(localStorage.getItem(KEY));
}

function persist(items: SavedDesign[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DESIGN_STORE_EVENT));
  }
}

function normalizeViewId(view: string): ViewId {
  if (view === 'three-quarter') return 'threeQuarter';
  return view as ViewId;
}

function normalizeDesign(design: SavedDesign): SavedDesign {
  return {
    ...design,
    versions: (design.versions || []).map((version) => ({
      ...version,
      views: (version.views || []).map((v) => normalizeViewId(String(v))),
      crops: (version.crops || []).map((c) => ({
        ...c,
        view: normalizeViewId(String(c.view)),
      })),
    })),
  };
}

export function listDesigns(): SavedDesign[] {
  return load();
}

export function getDesign(designId: string): SavedDesign | undefined {
  return load().find((d) => d.designId === designId);
}

export function createDesign(initialVersion: DesignVersion, title?: string): SavedDesign {
  const items = load();
  const now = new Date().toISOString();
  const design: SavedDesign = {
    designId: crypto.randomUUID(),
    title: title || deriveTitle(initialVersion.prompt),
    createdAt: now,
    updatedAt: now,
    versions: [initialVersion],
  };
  items.unshift(design);
  persist(items);
  return design;
}

export function addVersion(designId: string, version: DesignVersion): SavedDesign {
  const items = load();
  const idx = items.findIndex((d) => d.designId === designId);
  if (idx === -1) {
    return createDesign(version);
  }
  const updated: SavedDesign = {
    ...items[idx],
    updatedAt: new Date().toISOString(),
    versions: [version, ...items[idx].versions],
  };
  items[idx] = updated;
  persist(items);
  return updated;
}

export function deleteDesign(designId: string) {
  const items = load().filter((d) => d.designId !== designId);
  persist(items);
}

export function subscribeDesignStore(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const storageListener = (event: StorageEvent) => {
    if (event.key === KEY) {
      listener();
    }
  };
  window.addEventListener(DESIGN_STORE_EVENT, listener);
  window.addEventListener('storage', storageListener);
  return () => {
    window.removeEventListener(DESIGN_STORE_EVENT, listener);
    window.removeEventListener('storage', storageListener);
  };
}

function deriveTitle(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  return words || 'Untitled Design';
}
