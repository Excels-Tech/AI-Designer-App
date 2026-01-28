import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeHoodieMockupEcom } from './index';

const LIGHT_GRAY_BG = { r: 238, g: 238, b: 238, alpha: 1 };

async function meanLuma(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const pixels = (info.width ?? 1) * (info.height ?? 1);
  return sum / pixels;
}

test('normalizeHoodieMockupEcom respects noShadow option', async () => {
  // Build a small white square cutout on transparent background to simulate a hoodie mask.
  const cutout = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
        })
          .png()
          .toBuffer(),
        left: 20,
        top: 20,
      },
    ])
    .png()
    .toBuffer();

  const withShadow = await normalizeHoodieMockupEcom(Buffer.from(cutout), 'lightgray', { noShadow: false });
  const withoutShadow = await normalizeHoodieMockupEcom(Buffer.from(cutout), 'lightgray', { noShadow: true });

  // Shadowed version should be darker on average than the shadowless one.
  const lumaShadow = await meanLuma(withShadow);
  const lumaNoShadow = await meanLuma(withoutShadow);

  assert.ok(lumaNoShadow > lumaShadow, 'shadowless output should be brighter (no dark ellipse added)');
});
