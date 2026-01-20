import { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { safeJson } from '../utils/safeJson';

// Initialize Google GenAI client lazily
let genai: GoogleGenAI | null = null;

function getGenAI() {
    if (!genai) {
        genai = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        });
    }
    return genai;
}

const GENERATED_DIR = path.resolve(process.cwd(), 'server', 'public', 'generated');

// Ensure directory exists
if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

export async function generateImageHandler(req: Request, res: Response) {
    try {
        const { prompt, width, height, platform, designType } = req.body;

        if (!prompt) {
            return safeJson(res, { error: 'Prompt is required.' }, 400);
        }

        console.log('[Generate] Request received:', {
            width, height, platform, designType,
            hasApiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        });

        // 1. Enhance Prompt using Gemini text model for intelligent processing
        console.log(`[Generate] Original prompt: "${prompt}"`);

        const ai = getGenAI();
        let enhancedPrompt = prompt;

        try {
            const enhancementResponse = await ai.models.generateContent({
                model: 'gemini-2.0-flash',
                contents: `You are an expert prompt engineer for photorealistic AI image generation.

Transform this user prompt into a detailed, photorealistic image description. 

CRITICAL RULES:
1. Start with: "A candid, unposed photograph of..." or "An authentic, documentary-style photo of..."
2. Add: "shot on 35mm film", "natural ambient lighting", "grain and slight imperfections visible"
3. For people: "natural skin texture with pores and small imperfections", "asymmetrical features", "authentic expression"
4. Add: "no post-processing", "raw photo aesthetic", "photojournalistic style"
5. NEVER use: CGI, render, artistic, stylized, perfect, dramatic, hyper-real, illustration, painting

User prompt: ${prompt}
Platform: ${platform || 'social media'}

Output ONLY the enhanced prompt, nothing else:`,
            });

            const enhancedText = enhancementResponse.candidates?.[0]?.content?.parts?.[0]?.text;
            if (enhancedText) {
                enhancedPrompt = enhancedText.trim();
                console.log(`[Generate] Enhanced prompt: "${enhancedPrompt}"`);
            }
        } catch (enhanceErr) {
            console.log('[Generate] Prompt enhancement failed, using original:', enhanceErr);
        }

        // 2. Call Google Gemini Image Generation with enhanced prompt
        console.log('[Generate] Calling Gemini gemini-2.5-flash-image model...');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: enhancedPrompt,
            config: {
                responseModalities: ['image', 'text'],
            },
        });

        const images = [];

        // Extract image from response
        if (response.candidates && response.candidates[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData) {
                    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const filename = `${id}.png`;
                    const filepath = path.join(GENERATED_DIR, filename);

                    // Decode base64 image data
                    const imageData = part.inlineData.data;
                    if (!imageData) continue;

                    const buffer = Buffer.from(imageData, 'base64');

                    // Resize image to requested dimensions
                    console.log(`[Generate] Resizing ${id} to ${Math.round(width)}x${Math.round(height)}...`);
                    await sharp(buffer)
                        .resize({
                            width: Math.round(width),
                            height: Math.round(height),
                            fit: 'cover',
                        })
                        .toFile(filepath);

                    // Construct public URL
                    const url = `/generated/${filename}`;

                    images.push({
                        id,
                        url,
                        width: Math.round(width),
                        height: Math.round(height),
                        createdAt: new Date().toISOString(),
                        prompt: prompt,
                    });
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
