import type { ViewId } from './designStore';

export type DesignVersionResponse = {
  versionId: string;
  createdAt: string;
  combinedImage: string;
  prompt: string;
  style: string;
  resolution: number;
  format: string;
  quality: string;
  crops: { view: ViewId | string; dataUrl: string }[];
  views: (ViewId | string)[];
};

export type DesignResponse = {
  designId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  versions: DesignVersionResponse[];
};

export async function createDesign(payload: any) {
  const res = await fetch('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function addVersion(designId: string, payload: any) {
  const res = await fetch(`/api/designs/${designId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listDesigns() {
  const res = await fetch('/api/designs');
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<
    { designId: string; title: string; updatedAt: string; combinedImageUrl: string | null; versionCount: number }[]
  >;
}

export async function getDesign(designId: string) {
  const res = await fetch(`/api/designs/${designId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<DesignResponse>;
}

export async function deleteDesign(designId: string) {
  const res = await fetch(`/api/designs/${designId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}
