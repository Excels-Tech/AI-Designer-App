import sharp from 'sharp';
import { GeneratedView, Resolution } from './types.js';

const layouts: Record<number, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  3: { cols: 2, rows: 2 },
  4: { cols: 2, rows: 2 },
  5: { cols: 3, rows: 2 },
  6: { cols: 3, rows: 2 },
};

const BG = '#ffffff';

function ensureValidBuffer(buffer: Buffer, context: string) {
  if (!buffer || buffer.length < 100) {
    throw new Error(`Invalid image buffer passed to sharp (${context})`);
  }
}

export function resolutionToSize(resolution: Resolution): number {
  if (![512, 1024, 1536, 2048].includes(resolution)) {
    throw new Error('Invalid resolution format');
  }
  return resolution;
}

export function getLayout(count: number): { cols: number; rows: number } {
  const layout = layouts[count];
  if (!layout) {
    throw new Error('Unsupported number of views');
  }
  return layout;
}

export async function composeMultiView(
  views: GeneratedView[],
  resolution: Resolution
): Promise<{
  buffer: Buffer;
  layout: { cols: number; rows: number; width: number; height: number; cellSize: number };
}> {
  if (!views.length) {
    throw new Error('No views to compose');
  }

  const cellSize = resolutionToSize(resolution);
  const { cols, rows } = getLayout(views.length);
  const width = cols * cellSize;
  const height = rows * cellSize;

  const prepared = await Promise.all(
    views.map(async (view) => ({
      id: view.id,
      input: await (async () => {
        ensureValidBuffer(view.buffer, `compose:${view.id}`);
        return sharp(view.buffer).resize(cellSize, cellSize, { fit: 'cover' }).toBuffer();
      })(),
    }))
  );

  const composite = prepared.map((tile, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return {
      input: tile.input,
      top: row * cellSize,
      left: col * cellSize,
    };
  });

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: BG,
    },
  })
    .composite(composite)
    .png()
    .toBuffer();

  return {
    buffer,
    layout: { cols, rows, width, height, cellSize },
  };
}
