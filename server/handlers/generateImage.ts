import { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { safeJson } from '../utils/safeJson';
import fetch from 'node-fetch';
import { buildHoodieMockupPrompt, isHoodieMockupPrompt } from '../prompts/hoodieMockup';

// Initialize Google GenAI client lazily
let genai: GoogleGenerativeAI | null = null;

function getGenAI() {
    if (!genai) {
        genai = new GoogleGenerativeAI(
            (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) as string
        );
    }
    return genai;
}

const GENERATED_DIR = path.resolve(process.cwd(), 'server', 'public', 'generated');

const STATIONERY_DESIGN_TYPES = new Set([
    'catalog',
    'letterhead',
    'visiting_card',
    'logo',
    'envelope',
    'brochure',
]);

const STYLE_VARIANTS = [
    'Topband: ONE LOGO ONLY in top-left header; 18-24mm top accent band in brand color; small top-left logo; right-aligned contact row in footer; 12mm safe margins; provide monochrome logo variant.',
    'Corner flourish: ONE LOGO ONLY top-left; bold corner flourish in brand color at top-right; main body uncluttered; minimal centered contact footer; 12mm safe margins; monochrome variant.',
    'Minimal: ONE LOGO ONLY top-left; very wide whitespace, no decorative accents; clear typographic hierarchy; icons-only minimal footer; 12mm safe margins; monochrome variant.',
    'Footer-heavy: ONE LOGO ONLY top-left; minimal header, prominent footer with stacked contact info and separators; ensure 12mm safe margins; monochrome variant.'
];

const WATERMARK_VARIANT =
    'Diagonal watermark: ONE LOGO ONLY top-left; subtle diagonal accent at lower-right and very low-opacity watermark in lower quadrant; left-aligned footer contact row; 12mm safe margins; monochrome variant.';

// Ensure directory exists
if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

export async function generateImageHandler(req: Request, res: Response) {
    try {
        const { prompt, width, height, platform, designType, brandName, tagline, colors, tone, styleDescription, dnaImageUrl, is3D } = req.body;
        const normalizedDesignType = String(designType || '').trim().toLowerCase();
        const isStationery = STATIONERY_DESIGN_TYPES.has(normalizedDesignType);

        if (!prompt) {
            return safeJson(res, { error: 'Prompt is required.' }, 400);
        }

        console.log('[Generate] Request received:', {
            width, height, platform, designType, dnaImageUrl,
            hasApiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        });

        const ai = getGenAI();
        let finalPrompt = prompt;
        let visionDNA = '';

        // 0. Vision-based DNA extraction (if previous image provided)
        if (isStationery && dnaImageUrl) {
            try {
                const filename = path.basename(dnaImageUrl);
                const filepath = path.join(GENERATED_DIR, filename);
                if (fs.existsSync(filepath)) {
                    console.log(`[Generate] Analyzing Vision DNA for ${filename}...`);
                    const imgData = fs.readFileSync(filepath);
                    const visionModel = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });

                    const visionPrompt = `You are a high-precision brand identity auditor. 
Deconstruct the MASTER LOGO MARK in this image into a TECHNICAL BLUEPRINT.
Describe:
1. GEOMETRY: The exact SVG-like primitives (e.g. "Two overlapping triangles forming an 'M'").
2. BALANCE: The exact weight and line thickness.
3. COLOR: The precise shade or HEX-like intensity.
4. WORDMARK: The exact typography and letter spacing.

Output a single, clinical technical sentence that can be used to RECONSTRUCT this logo from scratch. No intro. No outro.`;

                    const result = await visionModel.generateContent([
                        visionPrompt,
                        {
                            inlineData: {
                                data: imgData.toString('base64'),
                                mimeType: 'image/png'
                            }
                        }
                    ]);
                    visionDNA = result.response.text().trim();
                    console.log(`[Generate] Extracted Vision DNA: "${visionDNA}"`);
                }
            } catch (visionErr) {
                console.error('[Generate] Vision DNA extraction failed:', visionErr);
            }
        }

        // 1. Build/enhance prompt
        console.log(`[Generate] Original prompt: "${prompt}"`);

        try {
            if (isStationery) {
                const activeStyleDNA = visionDNA || styleDescription || '';
                const hasVisualAnchor = !!dnaImageUrl;

                // --- HARD-CODED LOGO ISOLATION ---
                if (normalizedDesignType === 'logo') {
                    console.log('[Generate] Hard-Coded Logo Isolation Active.');
                    finalPrompt = `A PURE, professional corporate LOGO MARK and WORDMARK centered on a solid, PURE WHITE background (#FFFFFF).
BRAND: "${brandName || 'N/A'}"
COLORS: "${colors || 'N/A'}"
STYLE: Minimalist 2D vector graphic. 
STRICT CONSTRAINTS:
- ONE SINGLE LOGO ONLY. NO board. NO sheet. NO guide.
- NO PAGE LAYOUT. NO HEADERS. NO FOOTERS. 
- NO mockups. NO 3D. NO shadows. 
- Image must contain ONLY the logo mark and the text "${brandName}".`;

                    (req as any).visualDNA = activeStyleDNA;
                }
                // --- BRUTALIST REPLICATION ---
                else if (hasVisualAnchor && (normalizedDesignType === 'letterhead' || normalizedDesignType === 'visiting_card')) {
                    console.log(`[Generate] Brutalist Replication Active for ${normalizedDesignType}.`);

                    if (normalizedDesignType === 'letterhead') {
                        finalPrompt = `A professional, flat 2D A4 Letterhead template on a PURE WHITE background (#FFFFFF).
MANDATORY: Replicate the logo mark from the attached reference image exactly - use its geometry and colors.
LAYOUT STRUCTURE:
- TOP HEADER: Logo mark (top-left corner) with brand name "${brandName || 'Company'}" next to it
- BODY: Large empty white space (minimum 75% of page) for letter content
- FOOTER: Horizontal divider line with minimalist contact information (Phone, Website/URL, Email address)
DESIGN REQUIREMENTS:
- Use the exact colors from the reference logo
- Maintain 12mm safe margins on all sides
- Keep footer contact details minimal and right-aligned
- NO 3D effects, NO shadows, NO mockups, NO decorative flourishes
CRITICAL: Output a single, clean A4 letterhead design ready for printing.`;
                    } else {
                        finalPrompt = `A professional horizontal 2D Business Card on a PURE WHITE background (#FFFFFF).
MANDATORY: Use the logo mark from the attached reference image exactly. Replicate its geometry and colors.
LAYOUT:
- Show Front and Back side-by-side as flat rectangles.
- FRONT: Center the REPLICATED LOGO.
- BACK: Clean minimalist layout for Name and Contact info.
NO mockups. NO 3D. NO perspective.`;
                    }

                    (req as any).visualDNA = activeStyleDNA;
                } else {
                    // --- ENHANCEMENT MODE: FOR OTHER ITEMS ---
                    // Support `variant` in request body: 'random'|'seed:<n>'|'none'|'<custom string>'
                    const variantParamRaw = (req.body?.variant ?? '').toString();
                    const variantParam = variantParamRaw.trim().toLowerCase();

                    let chosenVariant: string | null = null;
                    const watermarkRequested =
                        /watermark/i.test(variantParamRaw) ||
                        /watermark/i.test(String(styleDescription ?? '')) ||
                        /watermark/i.test(String(prompt ?? ''));

                    if (styleDescription && String(styleDescription).trim()) {
                        chosenVariant = String(styleDescription).trim();
                    } else if (variantParam === 'none') {
                        chosenVariant = null; // explicitly no variant
                    } else if (variantParam.startsWith('seed:')) {
                        // deterministic pick from seed value
                        const seedValue = variantParamRaw.split(':')[1] ?? variantParamRaw;
                        const hex = crypto.createHash('sha256').update(String(seedValue)).digest('hex').slice(0, 8);
                        const idx = Number.parseInt(hex, 16) >>> 0;
                        chosenVariant = STYLE_VARIANTS[idx % STYLE_VARIANTS.length];
                    } else if (!variantParam || variantParam === 'random') {
                        chosenVariant = STYLE_VARIANTS[Math.floor(Math.random() * STYLE_VARIANTS.length)];
                    } else {
                        // treat unknown string as a custom variant description
                        chosenVariant = variantParamRaw;
                    }

                    if (watermarkRequested && variantParam !== 'none') {
                        chosenVariant = WATERMARK_VARIANT;
                    }

                    console.log('[Generate] Using stationery variant:', chosenVariant ?? 'none');

                    const stationeryInstruction = `You are a professional graphic designer. \nMISSION: Design a ${normalizedDesignType} for "${brandName}".\nCOLORS: "${colors || 'N/A'}"\nVARIANT: "${chosenVariant ?? ''}"\nDNA: "${activeStyleDNA}"\nConstraints: Flat 2D, white background, no mockups.\nOutput format:\n[PROMPT]: (Detailed prompt)\n[DNA]: (Technical summary)`;

                    const enhancementModel = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
                    const enhancementResponse = await enhancementModel.generateContent(stationeryInstruction);
                    const rawText = enhancementResponse.response.text() || '';

                    const promptMatch = rawText.match(/\[PROMPT\]\s*:\s*(.*)/is);
                    const dnaMatch = rawText.match(/\[DNA\]\s*:\s*(.*)/is);

                    if (promptMatch) {
                        finalPrompt = promptMatch[1].trim();
                    } else {
                        finalPrompt = (rawText.split('[DNA]')[0] || rawText).trim();
                    }

                    const finalDNA = (dnaMatch ? dnaMatch[1].trim() : `${activeStyleDNA}${chosenVariant ? ` | variant:${chosenVariant}` : ''}`).split('\n')[0];
                    (req as any).visualDNA = finalDNA;
                    (req as any).chosenVariant = chosenVariant;
                }
            } else {
                if (isHoodieMockupPrompt(prompt)) {
                    // Hoodie mockups must remain clean ecommerce product shots; avoid cinematic/film prompt additions.
                    finalPrompt = buildHoodieMockupPrompt({ basePrompt: prompt, is3D: is3D === true });
                } else {
                    const enhancementInstruction = `You are an expert prompt engineer for photorealistic AI image generation.
	
	Transform this user prompt into a detailed, photorealistic image description. 

CRITICAL RULES:
1. Start with: "A high-quality, professional studio photograph of..." or "A clean, well-lit product photo of..."
2. Add: "soft diffuse lighting", "matte finish", "clean solid background"
3. For people: "natural skin texture", "authentic expression"
4. Add: "plain background", "no shine", "no reflections", "no grain", "no noise"
5. NEVER use: CGI, render, artistic, stylized, perfect, dramatic, hyper-real, illustration, painting, grain, 35mm, film, artifacts

User prompt: ${prompt}
Platform: ${platform || 'social media'}
	
	Output ONLY the enhanced prompt, nothing else:`;

                    const enhancementModel = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
                    const enhancementResponse = await enhancementModel.generateContent(enhancementInstruction);

                    const enhancedText = enhancementResponse.response.text();
                    if (enhancedText) {
                        finalPrompt = enhancedText.trim();
                    }
                }
            }
        } catch (enhanceErr) {
            console.log('[Generate] Prompt enhancement failed, using original:', enhanceErr);
        }

        // 2. Call Google Gemini Image Generation with enhanced prompt
        console.log('[Generate] Calling image generation model (Gemini preferred, OpenAI fallback enabled)...');

        // Helper: OpenAI fallback for image generation
        const openAIGenerateImage = async (p: string) => {
            const openaiKey = process.env.OPENAI_API_KEY;
            if (!openaiKey) throw new Error('No OPENAI_API_KEY available for fallback.');

            const size = `1024x1024`;
            const body = {
                prompt: p,
                n: 1,
                size: size,
            };

            const resp = await fetch('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${openaiKey}`,
                },
                body: JSON.stringify(body),
            });

            if (!resp.ok) {
                const txt = await resp.text();
                throw new Error(`OpenAI image generation failed: ${resp.status} ${txt}`);
            }

            const data = await resp.json();
            const candidate = data?.data?.[0] || null;
            if (!candidate) {
                console.error('[Generate] OpenAI image response:', JSON.stringify(data));
                throw new Error('OpenAI response missing data[0].');
            }

            const b64 = candidate.b64_json || candidate.b64 || null;
            if (b64) return Buffer.from(b64, 'base64');

            const imageUrl = candidate.url || candidate.image_url || null;
            if (imageUrl) {
                const imgResp = await fetch(imageUrl);
                if (!imgResp.ok) throw new Error(`Failed to fetch OpenAI image URL: ${imgResp.status}`);
                const arrayBuffer = await imgResp.arrayBuffer();
                return Buffer.from(Buffer.from(arrayBuffer));
            }

            console.error('[Generate] OpenAI image response (no b64/url):', JSON.stringify(data));
            throw new Error('OpenAI response missing base64 image or URL.');
        };

        // Attempt Gemini first, on failure fall back to OpenAI image generation
        let images: any[] = [];
        try {
            const imageModel = ai.getGenerativeModel({ model: 'gemini-2.5-flash-image' });

            // Prepare parts for multinodal reference anchoring
            const parts: any[] = [{ text: finalPrompt }];

            if (isStationery && dnaImageUrl) {
                try {
                    const filename = path.basename(dnaImageUrl);
                    const filepath = path.join(GENERATED_DIR, filename);
                    if (fs.existsSync(filepath)) {
                        const imgData = fs.readFileSync(filepath);
                        parts.push({
                            inlineData: {
                                data: imgData.toString('base64'),
                                mimeType: 'image/png'
                            }
                        });
                        console.log(`[Generate] Attaching visual anchor reference: ${filename}`);
                    }
                } catch (err) {
                    console.warn('[Generate] Failed to attach visual anchor:', err);
                }
            }

            const result = await imageModel.generateContent({
                contents: [{ role: 'user', parts }],
                generationConfig: { responseModalities: ['image', 'text'] },
            } as any);

            const responseData = result.response;

            // Extract image from response
            if (responseData.candidates && responseData.candidates[0]?.content?.parts) {
                for (const part of responseData.candidates[0].content.parts) {
                    if (part.inlineData) {
                        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                        const filename = `${id}.png`;
                        const filepath = path.join(GENERATED_DIR, filename);

                        const imageData = part.inlineData.data;
                        if (!imageData) continue;

                        let buffer = Buffer.from(imageData, 'base64');
                        if (isHoodieMockupPrompt(prompt)) {
                            buffer = await sharp(buffer, { failOn: 'none' })
                                .ensureAlpha()
                                .modulate({ brightness: 0.92, saturation: 1.0 })
                                .linear(1, -6)
                                .png()
                                .toBuffer();
                        }

                        console.log(`[Generate] Resizing ${id} to ${Math.round(width)}x${Math.round(height)}...`);
                        await sharp(buffer).resize({ width: Math.round(width), height: Math.round(height), fit: 'cover' }).toFile(filepath);

                        const url = `/generated/${filename}`;

                        images.push({ id, url, width: Math.round(width), height: Math.round(height), createdAt: new Date().toISOString(), prompt: prompt, visualDNA: (req as any).visualDNA, variant: (req as any).chosenVariant ?? null });
                    }
                }
            }
        } catch (genErr) {
            console.warn('[Generate] Gemini image generation failed, attempting OpenAI fallback:', genErr?.message || genErr);
            if (process.env.OPENAI_API_KEY) {
                try {
                    let buffer = await openAIGenerateImage(finalPrompt);
                    if (isHoodieMockupPrompt(prompt)) {
                        buffer = await sharp(buffer, { failOn: 'none' })
                            .ensureAlpha()
                            .modulate({ brightness: 0.92, saturation: 1.0 })
                            .linear(1, -6)
                            .png()
                            .toBuffer();
                    }
                    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const filename = `${id}.png`;
                    const filepath = path.join(GENERATED_DIR, filename);
                    await sharp(buffer).resize({ width: Math.round(width), height: Math.round(height), fit: 'cover' }).toFile(filepath);
                    const url = `/generated/${filename}`;
                    images.push({ id, url, width: Math.round(width), height: Math.round(height), createdAt: new Date().toISOString(), prompt: prompt, visualDNA: (req as any).visualDNA, variant: (req as any).chosenVariant ?? null });
                } catch (openErr) {
                    console.error('[Generate] OpenAI fallback failed:', openErr);
                }
            }
        }

        if (images.length === 0) {
            console.error('[Generate] No image generated from Gemini response');
            return safeJson(res, { error: 'No image was generated. Please try a different prompt.' }, 500);
        }

        return safeJson(res, { images });
    } catch (err: any) {
        console.error('[Generate] CRITICAL ERROR:', err);
        console.error('[Generate] Error Stack:', err?.stack);

        // Simple error mapping
        const msg = err?.message || 'Image generation failed.';
        if (msg.includes('billing')) return safeJson(res, { error: 'API billing limit reached.' }, 402);
        if (msg.includes('safety') || msg.includes('blocked')) return safeJson(res, { error: 'Prompt triggered safety filters.' }, 400);
        if (msg.includes('401') || msg.includes('API key')) return safeJson(res, { error: 'Invalid API Key.' }, 401);

        return safeJson(res, { error: `Server Error: ${msg}` }, 500);
    }
}
