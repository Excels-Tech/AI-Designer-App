export interface GeneratedTileLike {
  view: string;
  dataUrl: string;
  buffer: Buffer;
}

export interface CompositeLike {
  dataUrl: string;
  buffer: Buffer;
  dimensions: { width: number; height: number };
}

export interface GridLike {
  columns: number;
  rows: number;
}

export function buildGenerateViewsResponse(args: {
  composite: CompositeLike;
  tiles: GeneratedTileLike[];
  grid: GridLike;
  tileWidth: number;
  tileHeight: number;
  viewOrder: string[];
  designId?: string;
}) {
  const { composite, tiles, grid, tileWidth, tileHeight, viewOrder, designId } = args;

  return {
    composite: composite.dataUrl,
    images: tiles.map((tile) => ({
      view: tile.view,
      src: tile.dataUrl,
    })),
    compositePngBase64: composite.buffer.toString('base64'),
    parts: tiles.map((tile) => ({
      view: tile.view,
      base64: tile.dataUrl.replace(/^data:image\/png;base64,/, ''),
    })),
    meta: {
      dimensions: composite.dimensions,
      grid: { ...grid, tileWidth, tileHeight },
      viewOrder,
    },
    designId,
  };
}

