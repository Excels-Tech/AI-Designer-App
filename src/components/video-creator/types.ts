export type FontStyle = 'modern' | 'classic' | 'bold' | 'script';
export type TextPosition = 'top' | 'center' | 'bottom' | 'custom';
export type SlideAnimation = 'fadeIn' | 'slide' | 'zoom' | 'rotate' | 'none';

export type Slide = {
  id: string;
  imageSrc: string;
  assetId?: string;
  durationSec: number;
  overlayText: string;
  overlayColorHex: string;
  fontStyle: FontStyle;
  fontSizePx: number;
  position: TextPosition;
  xPct?: number;
  yPct?: number;
  animation: SlideAnimation;
};

export type VideoProject = {
  id: string;
  quality: '720p' | '1080p';
  format: 'mp4';
  fps: number;
  slides: Slide[];
  width?: number;
  height?: number;
};
