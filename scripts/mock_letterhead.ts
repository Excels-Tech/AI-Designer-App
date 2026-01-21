import fs from 'fs';
import path from 'path';
import { maybeEnhancePrompt } from '../server/promptEnhancer/runtime';

const args = process.argv.slice(2);
const company = args[0] ?? 'Company Name';
const outDir = path.join(process.cwd(), 'public', 'generated');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const promptRes = maybeEnhancePrompt(`create a professional letterhead with the company logo for ${company}`, { creativity: 0.2, aspectRatio: '4:3' }, 'mock');
const preface = promptRes.promptForModel.split('.').slice(0, 2).join('.').trim();

const timestamp = Date.now();
const filename = `letterhead-${company.replace(/\s+/g, '_')}-${timestamp}.svg`;
const filePath = path.join(outDir, filename);

// Simple A4-ish SVG mockup (not to scale), top-left logo box, footer, watermark text
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="2480" height="3508" viewBox="0 0 2480 3508">
  <rect width="100%" height="100%" fill="#ffffff" />
  <!-- Top-left logo area -->
  <g id="header">
    <rect x="120" y="120" width="420" height="140" fill="#f2f2f2" stroke="#e0e0e0" rx="8" />
    <text x="140" y="200" font-family="Arial, Helvetica, sans-serif" font-size="48" fill="#111">${company}</text>
  </g>

  <!-- Subtle watermark -->
  <g opacity="0.06" font-family="Arial, Helvetica, sans-serif">
    <text x="300" y="1800" font-size="220" fill="#000" transform="rotate(-30 300 1800)">${company}</text>
  </g>

  <!-- Body placeholder -->
  <g id="body">
    <rect x="120" y="300" width="2240" height="2800" fill="none" stroke="none" />
  </g>

  <!-- Footer contact row -->
  <g id="footer">
    <line x1="120" y1="3360" x2="2360" y2="3360" stroke="#e6e6e6" stroke-width="2" />
    <text x="140" y="3420" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#333">Address • Phone • Email • Website</text>
  </g>

  <!-- Prompt note (for reference) -->
  <g id="note">
    <rect x="120" y="3460" width="2240" height="36" fill="none" />
    <text x="120" y="3484" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#666">${preface.replace(/"/g, '\\"')}</text>
  </g>
</svg>`;

fs.writeFileSync(filePath, svg, 'utf8');
console.log('Wrote mock letterhead:', filePath);
