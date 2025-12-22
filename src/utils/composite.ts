export interface CompositeLayer {
  id: string;
  imageUrl?: string;
  originalCutoutUrl?: string;
  maskUrl?: string;
  maskDataUrl?: string;
  color?: string;
  originalAverageColor?: string;
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

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '').trim();
  const value = normalized.length === 3 ? normalized.split('').map((ch) => ch + ch).join('') : normalized;
  const intVal = Number.parseInt(value, 16);
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255,
  };
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }
  h = Math.round(h * 60);
  if (h < 0) h += 360;

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h >= 0 && h < 60) [r, g, b] = [c, x, 0];
  else if (h >= 60 && h < 120) [r, g, b] = [x, c, 0];
  else if (h >= 120 && h < 180) [r, g, b] = [0, c, x];
  else if (h >= 180 && h < 240) [r, g, b] = [0, x, c];
  else if (h >= 240 && h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

async function applyMaskedHueShift(canvas: HTMLCanvasElement, maskSrc: string, targetHex: string, opacity: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context not available.');
  const maskImg = await loadImage(maskSrc);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) throw new Error('Canvas 2D context not available.');
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);

  const targetRgb = hexToRgb(targetHex);
  const targetHsl = rgbToHsl(targetRgb.r, targetRgb.g, targetRgb.b);
  const clampOpacity = Math.max(0, Math.min(opacity, 1));

  const data = imageData.data;
  const mask = maskData.data;
  for (let i = 0; i < data.length; i += 4) {
    const maskVal = mask[i]; // grayscale mask encoded as RGB
    if (maskVal === 0) continue;
    const strength = (maskVal / 255) * clampOpacity;
    if (strength <= 0) continue;

    const { l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const recolored = hslToRgb(targetHsl.h, targetHsl.s, l);
    data[i] = Math.round(data[i] + (recolored.r - data[i]) * strength);
    data[i + 1] = Math.round(data[i + 1] + (recolored.g - data[i + 1]) * strength);
    data[i + 2] = Math.round(data[i + 2] + (recolored.b - data[i + 2]) * strength);
  }

  ctx.putImageData(imageData, 0, 0);
}

export async function renderComposite(layers: CompositeLayer[]) {
  const baseLayer = layers.find((layer) => layer.type === 'image' && layer.imageUrl);
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

  if (baseLayer.visible) {
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
    const autoLayers = layers
      .filter((layer) => layer.type === 'auto-extracted' && layer.visible)
      .filter((layer) => (layer.maskDataUrl || layer.maskUrl) && layer.color)
      .filter((layer) => {
        if (!layer.originalAverageColor) return true;
        return String(layer.color).toLowerCase() !== String(layer.originalAverageColor).toLowerCase();
      });

    for (const layer of autoLayers) {
      const maskSrc = (layer.maskDataUrl || layer.maskUrl) as string;
      const opacity = layer.opacity ?? 1;
      await applyMaskedHueShift(canvas, maskSrc, layer.color as string, opacity);
    }
  }

  const orderedLayers = [
    ...layers.filter((layer) => layer.type === 'image' && layer.visible),
    ...layers.filter((layer) => layer.type === 'auto-extracted' && layer.visible),
    ...layers.filter((layer) => layer.type === 'logo' || layer.type === 'uploaded'),
    ...layers.filter((layer) => !['image', 'auto-extracted', 'logo', 'uploaded'].includes(layer.type)),
  ];

  for (const layer of orderedLayers) {
    if (!layer.visible) continue;

    if (layer.type === 'auto-extracted') {
      if (baseLayer.visible) continue;
      const src = layer.originalCutoutUrl || layer.imageUrl;
      if (!src) continue;
      const img = await loadImage(src);
      ctx.globalAlpha = Math.max(0, Math.min(layer.opacity ?? 1, 1));
      ctx.globalCompositeOperation = layer.blendMode || 'source-over';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      continue;
    }

    if (!layer.imageUrl) continue;
    const img = await loadImage(layer.imageUrl);
    ctx.globalAlpha = Math.max(0, Math.min(layer.opacity ?? 1, 1));
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
      // image layer already drawn above if visible; only draw if not base (e.g. rendered overlays)
      if (layer.id !== baseLayer.id) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}
