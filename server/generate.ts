import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { buildBasePrompt, buildDerivedPrompt } from './promptBuilder.js';
import { GenerateRequestBody, GeneratedView, StyleId, ViewId } from './types.js';

const IMAGE_MODEL = 'gemini-2.5-flash-image';
const TEXT_MODEL = 'gemini-2.5-flash';
const MAX_SIDE_RETRIES = 2;
const CANONICAL: ViewId[] = ['front', 'back', 'left', 'right', 'threeQuarter', 'top'];
const DUP_THRESHOLD = 2;

function ensureValidBuffer(buffer: Buffer, context: string) {
  if (!buffer || buffer.length < 100) {
    throw new Error(`Invalid image buffer passed to sharp (${context})`);
  }
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  return new GoogleGenAI({ apiKey });
}

function extractImageBuffer(result: any, context: string): Buffer {
  console.log('Gemini response received', context ? `(${context})` : '');

  const parts = result?.candidates?.[0]?.content?.parts;

  if (!parts || !Array.isArray(parts)) {
    throw new Error('Gemini response has no parts');
  }

  const imagePart = parts.find((p: any) => p?.inlineData?.data);
  if (!imagePart) {
    console.error('Gemini parts:', JSON.stringify(parts, null, 2));
    throw new Error('Gemini did not return image inlineData');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

async function normalizeImage(buffer: Buffer, resolution: number): Promise<Buffer> {
  ensureValidBuffer(buffer, 'normalizeImage');

  return sharp(buffer)
    .resize(resolution, resolution, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
}

async function computeMad(a: Buffer, b: Buffer): Promise<number> {
  ensureValidBuffer(a, 'computeMad:a');
  ensureValidBuffer(b, 'computeMad:b');

  const size = 64;
  const toGray = async (buf: Buffer) =>
    sharp(buf)
      .resize(size, size)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer();
  const [ga, gb] = await Promise.all([toGray(a), toGray(b)]);
  let sum = 0;
  const len = ga.length;
  for (let i = 0; i < len; i++) {
    sum += Math.abs(ga[i] - gb[i]);
  }
  return sum / len;
}

async function classifyView(client: GoogleGenAI, buffer: Buffer): Promise<string> {
  const result = await client.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: 'image/png',
        },
      },
      {
        text: 'Classify the garment view as one of: front, back, left, right, top, three-quarter, other. Reply with just the label.',
      },
    ],
  });
  const text = result?.candidates?.[0]?.content?.parts?.map((p: any) => p.text)?.join('') || '';
  return text.trim().toLowerCase();
}

export async function generateBaseImage(
  prompt: string,
  style: StyleId,
  view: ViewId,
  resolution: number
): Promise<Buffer> {
  const client = getClient();
  const viewPrompt = buildBasePrompt(prompt, style, view);
  const result = await client.models.generateContent({
    model: IMAGE_MODEL,
    contents: viewPrompt,
    generationConfig: { responseMimeType: 'image/png' },
  });

  const buffer = extractImageBuffer(result, `[generateBaseImage:${view}]`);
  return normalizeImage(buffer, resolution);
}

export async function generateDerivedViewImage(
  prompt: string,
  style: StyleId,
  targetView: ViewId,
  baseImage: Buffer,
  resolution: number,
  options?: { extraInstruction?: string }
): Promise<Buffer> {
  const client = getClient();
  const derivedPrompt = [buildDerivedPrompt(prompt, style, targetView), options?.extraInstruction]
    .filter(Boolean)
    .join('\n');
  const base64 = baseImage.toString('base64');

  const generateOnce = async () => {
    const result = await client.models.generateContent({
      model: IMAGE_MODEL,
      contents: [
        { inlineData: { data: base64, mimeType: 'image/png' } },
        { text: derivedPrompt },
      ],
      generationConfig: { responseMimeType: 'image/png' },
    });
    const buffer = extractImageBuffer(result, `[generateDerived:${targetView}]`);
    return normalizeImage(buffer, resolution);
  };

  const needsValidation = targetView === 'left' || targetView === 'right';
  if (!needsValidation) {
    return generateOnce();
  }

  for (let attempt = 1; attempt <= MAX_SIDE_RETRIES + 1; attempt++) {
    // eslint-disable-next-line no-console
    console.log(`[generate] ${targetView.toUpperCase()} (attempt ${attempt}/${MAX_SIDE_RETRIES + 1})`);
    const candidate = await generateOnce();
    try {
      const classified = await classifyView(client, candidate);
      // eslint-disable-next-line no-console
      console.log(`[generate] ${targetView.toUpperCase()} classified as: ${classified}`);
      if (classified === targetView) {
        return candidate;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[generate] classification error', err);
    }
    if (attempt > MAX_SIDE_RETRIES) return candidate;
  }

  return generateOnce();
}

export async function generateAllViews(body: GenerateRequestBody): Promise<GeneratedView[]> {
  const requestedViews = body.views.map((v) =>
    v === ('three-quarter' as any) ? ('threeQuarter' as ViewId) : v
  ) as ViewId[];
  const orderedViews = CANONICAL.filter((v) => requestedViews.includes(v));
  if (!orderedViews.length) {
    throw new Error('No valid views requested');
  }
  const baseView: ViewId = orderedViews.includes('front') ? 'front' : orderedViews[0];
  const otherViews = orderedViews.filter((v) => v !== baseView);

  const baseBuffer = await generateBaseImage(body.prompt, body.style, baseView, body.resolution);
  const generated: GeneratedView[] = [{ id: baseView, buffer: baseBuffer }];

  for (const view of otherViews) {
    const buffer = await generateDerivedViewImage(
      body.prompt,
      body.style,
      view,
      baseBuffer,
      body.resolution
    );
    generated.push({ id: view, buffer });
  }

  // Ensure left/right are distinct; if too similar, retry right then flop as fallback
  const left = generated.find((g) => g.id === 'left');
  const right = generated.find((g) => g.id === 'right');
  if (left && right) {
    ensureValidBuffer(left.buffer, 'left comparison');
    ensureValidBuffer(right.buffer, 'right comparison');

    let mad = await computeMad(left.buffer, right.buffer);

    if (mad < DUP_THRESHOLD) {
      // eslint-disable-next-line no-console
      console.log('[generate] RIGHT duplicate detected; retrying...');
      const retryPrompt = 'RIGHT SIDE ONLY. FRONT MUST FACE LEFT. DO NOT OUTPUT LEFT VIEW.';
      for (let attempt = 1; attempt <= MAX_SIDE_RETRIES; attempt++) {
        const retryBuffer = await generateDerivedViewImage(
          body.prompt,
          body.style,
          'right',
          baseBuffer,
          body.resolution,
          { extraInstruction: retryPrompt }
        );
        ensureValidBuffer(retryBuffer, `right retry ${attempt}`);
        const retryMad = await computeMad(left.buffer, retryBuffer);
        if (retryMad >= DUP_THRESHOLD) {
          right.buffer = retryBuffer;
          mad = retryMad;
          break;
        }
        if (attempt < MAX_SIDE_RETRIES) {
          // eslint-disable-next-line no-console
          console.log('[generate] RIGHT duplicate detected; retrying...');
        }
      }
    }

    if (mad < DUP_THRESHOLD) {
      // eslint-disable-next-line no-console
      console.log('[generate] fallback flop() applied');
      right.buffer = await sharp(left.buffer).flop().toBuffer();
    }
  }

const map: Record<ViewId, Buffer> = generated.reduce(
    (acc, g) => ({ ...acc, [g.id]: g.buffer }),
    {} as Record<ViewId, Buffer>
  );
  return orderedViews.map((id) => ({ id, buffer: map[id] }));
}
