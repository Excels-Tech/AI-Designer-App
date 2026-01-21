import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { maybeEnhancePrompt } from '../server/promptEnhancer/runtime';

const company = process.argv[2] ?? 'WebExcel';
const outDir = path.join(process.cwd(), 'public', 'generated');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function writeSvg(name: string, svg: string) {
  const file = path.join(outDir, `${name}.svg`);
  fs.writeFileSync(file, svg, 'utf8');
  return file;
}

async function toPng(svgPath: string, pngPath: string) {
  const svg = fs.readFileSync(svgPath);
  await sharp(svg).png().resize(1240, 1754).toFile(pngPath);
}

// Generate 3 variants inspired by the images you provided
const timestamp = Date.now();

// Variant A: Top header band with accent and top-left logo
const svgA = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2480 3508">
  <rect width="100%" height="100%" fill="#ffffff" />
  <rect x="0" y="0" width="2480" height="220" fill="#0b66c3" />
  <g transform="translate(120,40)">
    <rect x="0" y="0" width="420" height="140" rx="8" fill="#ffffff" />
    <text x="30" y="90" font-family="Arial, Helvetica, sans-serif" font-size="64" fill="#0b66c3">${company}</text>
  </g>
  <g opacity="0.06" transform="rotate(-30 300 1800)">
    <text x="300" y="1800" font-family="Arial" font-size="220" fill="#000">${company}</text>
  </g>
  <line x1="120" y1="3300" x2="2360" y2="3300" stroke="#e6e6e6" stroke-width="2" />
  <text x="140" y="3430" font-family="Arial" font-size="34" fill="#333">Address • Phone • Email • Website</text>
</svg>`;

// Variant B: Corner accent and large top-left logo area (like image 3)
const svgB = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2480 3508">
  <rect width="100%" height="100%" fill="#ffffff" />
  <path d="M2480 0 L2480 320 L2000 0 Z" fill="#f39c12" />
  <g transform="translate(120,80)">
    <text x="0" y="60" font-family="Arial, Helvetica, sans-serif" font-size="72" fill="#111">${company}</text>
  </g>
  <rect x="2000" y="3000" width="400" height="400" rx="8" fill="#f6f6f6" opacity="0.3" />
  <text x="140" y="3430" font-family="Arial" font-size="34" fill="#333">Address • Phone • Email • Website</text>
</svg>`;

// Variant C: Diagonal bottom accent + subtle watermark (like image 1)
const svgC = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2480 3508">
  <rect width="100%" height="100%" fill="#ffffff" />
  <g transform="translate(120,40)">
    <text x="0" y="80" font-family="Arial, Helvetica, sans-serif" font-size="64" fill="#111">${company}</text>
  </g>
  <polygon points="0,3000 2480,3508 2480,3200 0,2700" fill="#f2f2f2" />
  <g opacity="0.06" transform="rotate(-30 300 1800)">
    <text x="300" y="1800" font-family="Arial" font-size="220" fill="#000">${company}</text>
  </g>
  <text x="140" y="3430" font-family="Arial" font-size="34" fill="#333">Address • Phone • Email • Website</text>
</svg>`;

const files: { name: string; svg: string }[] = [
  { name: `letterhead-topband-${timestamp}`, svg: svgA },
  { name: `letterhead-corner-${timestamp}`, svg: svgB },
  { name: `letterhead-diagonal-${timestamp}`, svg: svgC },
];

(async () => {
  for (const f of files) {
    const svgPath = writeSvg(f.name, f.svg);
    const pngPath = path.join(outDir, `${f.name}.png`);
    try {
      await toPng(svgPath, pngPath);
      console.log('Wrote', svgPath, 'and', pngPath);
    } catch (err) {
      console.error('Conversion error for', svgPath, err);
    }
  }
  console.log('Done. Variants created in public/generated.');
})();
