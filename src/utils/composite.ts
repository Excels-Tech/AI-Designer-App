export interface CompositeLayer {
  id: string;
  imageUrl?: string;
  visible: boolean;
  type: string;
  position?: { x: number; y: number };
  scale?: number;
  opacity?: number;
  blendMode?: GlobalCompositeOperation;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for compositing.'));
    img.src = src;
  });
}

export async function renderComposite(layers: CompositeLayer[]) {
  const visibleLayers = layers.filter((layer) => layer.visible && layer.imageUrl);
  if (!visibleLayers.length) {
    throw new Error('No visible layers to composite.');
  }

  const baseLayer = visibleLayers.find((layer) => layer.type === 'image') ?? visibleLayers[0];
  if (!baseLayer.imageUrl) {
    throw new Error('Base layer is missing.');
  }

  const baseImage = await loadImage(baseLayer.imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = baseImage.width || 1024;
  canvas.height = baseImage.height || 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context not available.');
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const orderedLayers = [
    ...layers.filter((layer) => layer.type === 'image'),
    ...layers.filter((layer) => layer.type === 'auto-extracted'),
    ...layers.filter((layer) => layer.type === 'logo' || layer.type === 'uploaded'),
    ...layers.filter((layer) => !['image', 'auto-extracted', 'logo', 'uploaded'].includes(layer.type)),
  ];

  for (const layer of orderedLayers) {
    if (!layer.visible || !layer.imageUrl) continue;
    const img = await loadImage(layer.imageUrl);
    const opacity = layer.opacity ?? 1;
    ctx.globalAlpha = Math.max(0, Math.min(opacity, 1));
    ctx.globalCompositeOperation = layer.blendMode || 'source-over';

    if (layer.type === 'logo' || layer.type === 'uploaded') {
      const scale = layer.scale ?? 1;
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      const posX = (layer.position?.x ?? 50) / 100;
      const posY = (layer.position?.y ?? 50) / 100;
      const left = canvas.width * posX - width / 2;
      const top = canvas.height * posY - height / 2;
      ctx.drawImage(img, left, top, width, height);
    } else {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}
