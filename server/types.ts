export type ViewId = 'front' | 'back' | 'left' | 'right' | 'threeQuarter' | 'top';

export type StyleId = 'realistic' | '3d' | 'lineart' | 'watercolor';

export type Resolution = 512 | 1024 | 1536 | 2048;

export interface GenerateRequestBody {
  prompt: string;
  style: StyleId;
  resolution: Resolution;
  views: ViewId[];
}

export interface GeneratedView {
  id: ViewId;
  buffer: Buffer;
}

export interface GenerateResponseBody {
  combinedImage: string;
  views: {
    view: ViewId;
    image: string;
  }[];
  meta: {
    baseView: ViewId;
    style: StyleId;
    resolution: Resolution;
  };
}
