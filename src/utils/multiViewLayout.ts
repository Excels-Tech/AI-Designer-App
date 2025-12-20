export type Layout = { cols: number; rows: number };

export function getLayout(viewCount: number): Layout {
  if (viewCount <= 1) return { cols: 1, rows: 1 };
  if (viewCount === 2) return { cols: 2, rows: 1 };
  if (viewCount <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

export function getCellRects(
  imgWidth: number,
  imgHeight: number,
  cols: number,
  rows: number
): { x: number; y: number; w: number; h: number }[] {
  const cellWidth = imgWidth / cols;
  const cellHeight = imgHeight / rows;
  const rects: { x: number; y: number; w: number; h: number }[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      rects.push({
        x: Math.round(col * cellWidth),
        y: Math.round(row * cellHeight),
        w: Math.round(cellWidth),
        h: Math.round(cellHeight),
      });
    }
  }

  return rects;
}
