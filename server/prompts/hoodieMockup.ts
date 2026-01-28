export type HoodieLogoPlacement =
    | 'wearers_right_chest'
    | 'wearers_left_chest'
    | 'center_chest'
    | 'none'
    | { description: string };

export function isHoodieMockupPrompt(p: string): boolean {
    const s = String(p ?? '').toLowerCase();
    if (!s.trim()) return false;

    // Accept common misspellings like "hoddie" (user input) and variants.
    const mentionsHoodie = /\b(hoodie|hoddie|hoody|hoodi|pullover\s+(hoodie|hoddie|hoody)|sweatshirt\s+(hoodie|hoddie|hoody))\b/i.test(
        s
    );
    if (!mentionsHoodie) return false;

    // If the user explicitly asks for a person/model wearing it, treat it as fashion not a product mockup.
    if (/\b(man|woman|person|people|model|wearing|on\s+a\s+person|on\s+body|streetwear\s+photo|lookbook)\b/i.test(s)) {
        return false;
    }

    return true;
}

function inferBaseColorFromPrompt(p: string): string | undefined {
    const s = String(p ?? '').toLowerCase();
    if (!s.trim()) return undefined;

    const colorWords = [
        'off-white',
        'off white',
        'white',
        'black',
        'gray',
        'grey',
        'navy',
        'blue',
        'red',
        'green',
        'yellow',
        'orange',
        'purple',
        'pink',
        'beige',
        'cream',
        'brown',
        'maroon',
        'teal',
    ];

    for (const w of colorWords) {
        const token = w.replace(/\s+/g, '[-\\s]+');
        const re = new RegExp(`\\b${token}\\b`, 'i');
        if (re.test(s)) {
            const normalized = w.replace(/\s+/g, ' ');
            return normalized.toLowerCase() === 'grey' ? 'gray' : normalized;
        }
    }

    return undefined;
}

function describeLogoPlacement(placement: HoodieLogoPlacement | undefined): string {
    if (!placement) {
        return "Print the provided logo on the right chest (wearer's right), small, flat ink print (not embroidered).";
    }
    if (placement === 'none') return 'Do not add any logo or text.';
    if (placement === 'center_chest') return 'Print the provided logo centered on the chest, small, flat ink print (not embroidered).';
    if (placement === 'wearers_left_chest')
        return "Print the provided logo on the left chest (wearer's left), small, flat ink print (not embroidered).";
    if (placement === 'wearers_right_chest')
        return "Print the provided logo on the right chest (wearer's right), small, flat ink print (not embroidered).";
    return `Logo placement: ${placement.description}`;
}

export function buildHoodieMockupPrompt(args: {
    basePrompt: string;
    logoPlacement?: HoodieLogoPlacement;
    hoodieColor?: string;
    brandName?: string;
    is3D?: boolean;
    bgColor?: string;
}): string {
    const basePrompt = String(args.basePrompt ?? '').trim();
    const hoodieColorRaw = String(args.hoodieColor ?? '').trim();
    const inferred = inferBaseColorFromPrompt(basePrompt);
    const is3D = args.is3D === true;

    const isExplicitWhite = /\bwhite\b/i.test(hoodieColorRaw);
    const hoodieColor =
        (hoodieColorRaw
            ? isExplicitWhite
                ? 'pure white (#FFFFFF)'
                : hoodieColorRaw
            : inferred && /\b(white|off white|off-white)\b/i.test(inferred)
                ? 'pure white (#FFFFFF)'
                : inferred) || 'off-white (#f7f7f7)';

    const placementLine = describeLogoPlacement(args.logoPlacement);
    const brandName = String(args.brandName ?? '').trim();

    // Determine background color: light gray for white products, pure white for others.
    // If an explicit bgColor is provided, respect it.
    const isWhiteProduct = /\b(white|off-white|off white|cream|ivory)\b/i.test(hoodieColor);
    let backgroundColor = '';
    if (args.bgColor === 'lightgray') {
        backgroundColor = isWhiteProduct ? 'LIGHT GRAY background (#DADADA)' : 'LIGHT GRAY background (#EEEEEE)';
    } else if (args.bgColor === 'white') {
        backgroundColor = 'PURE WHITE background (#FFFFFF)';
    } else {
        backgroundColor = isWhiteProduct ? 'LIGHT GRAY background (#DADADA)' : 'PURE WHITE background (#FFFFFF)';
    }

    // Build plain or 3D template
    let template: string;
    let negative: string;
    const catalogFlat = isWhiteProduct; // Force catalog-flat mode for white garments.

    if (catalogFlat) {
        const whiteFabricControl = `WHITE FABRIC CRITICAL: Garment must be pure white (#FFFFFF) with uniform matte cotton texture. Garment must remain brighter than the background everywhere. Do NOT tint the garment gray to match the background. Even luminance across the entire garment.`;

        template = `E-commerce catalog flat render (NOT a photo, NOT realistic). Plain cotton hoodie in ${hoodieColor}. Front view on ${backgroundColor}. ${whiteFabricControl} Flat, uniform, vector-like lighting; NO directional lighting, NO cast shadows, NO depth shading, NO global illumination gradients, NO ambient occlusion. Even luminance across the garment; garment brighter than background everywhere. Do NOT apply left-to-right or top-to-bottom brightness gradients on the garment. Hood interior darkness must not influence exterior fabric brightness. Keep the hoodie completely unbranded and plain (no logos, no text, no graphics, no labels). Background must stay perfectly clean and uniform with zero shadows or gradients.`;

        negative =
            'NEGATIVE: realistic photo, photography, studio lighting, directional light, shadows, shading, gradient lighting, ambient occlusion, glossy, shiny, reflective, plastic, vinyl, leather, specular, wet look, bloom, lens flare, vignette, gradient background, noise, grain, texture on background, props, scene, people, mannequin.';
    } else if (is3D) {
        // 3D Mode - photorealistic but plain, no branding
        const whiteFabricControl = isWhiteProduct
            ? 'WHITE FABRIC CRITICAL: Render true matte cotton white fabric (#F5F5F5 to #FAFAFA). The fabric MUST be completely matte with ZERO shine, ZERO gloss, ZERO specularity, ZERO reflections. ABSOLUTELY NO plastic appearance, NO vinyl look, NO wet appearance, NO glossy surface, NO shiny patches, NO highlight sparkle. The cotton must look dry, soft, and completely non-reflective. Maintain visible seams and fabric texture through subtle shading only. Proper exposure - avoid overexposed blown whites while keeping fabric detail visible. Clean, uniform white cotton surface free of noise, grain, or speckles.'
            : '';

        template = `Photorealistic 3D product render of a plain cotton hoodie in ${hoodieColor}. Front view. ${backgroundColor}. ${whiteFabricControl} Keep the hoodie completely unbranded and plain (no logos, no text, no graphics, no labels). Flat, uniform, front-facing catalog lighting only; zero directional lighting, zero global illumination gradients, zero ambient occlusion. Fabric brightness must stay uniform across the entire garment and always be brighter than the background everywhere.`;

        negative =
            'NEGATIVE: shiny, glossy, gloss, shine, specularity, specular, specular highlight, reflective, reflections, reflection, wet look, wet appearance, plastic, vinyl, leather, satin, silk, lustrous, polished, sheen, glint, sparkle, highlight sparkle, blown highlights, overexposed, clipped whites, hot spots, glare, metallic, pearlescent, iridescent, shimmer, glass-like, smooth plastic, PVC, latex, text, logo, wordmark, brand name, numbers, slogans, labels, embroidery, print, pattern, graphic, sticker, decal, watermark, cartoon, line art, flat vector, illustration, noisy background, grain, gradient background, vignette, props, room, scene, people, mannequin head, body, noise, grainy texture, speckles, salt-and-pepper noise, film grain, digital noise, artifacts, compression artifacts.';
    } else {
        // Realistic Mode - Professional product photography with realistic fabric texture but NO shadows
        const whiteFabricControl = isWhiteProduct
            ? `\n\nWHITE FABRIC CRITICAL: Render authentic matte cotton white fabric (#F5F5F5 to #FAFAFA). ENFORCE COMPLETELY MATTE FINISH - ZERO shine, ZERO gloss, ZERO specularity, ZERO reflections, ZERO highlight sparkle. The fabric MUST appear completely non-reflective like dry cotton fleece. ABSOLUTELY NO plastic appearance, NO vinyl surface, NO wet look, NO glossy patches, NO shiny areas, NO specular highlights, NO reflective surface. The cotton must look soft, dry, and diffusely lit with uniform matte texture across the entire garment. Preserve fabric detail only through subtle natural shadow in folds and seams - NO noise, NO grain, NO speckles. Balanced exposure showing fabric texture without overexposed hot spots or blown whites. The surface must be uniformly matte like real uncoated cotton sweatshirt fabric. Do NOT tint the garment gray to match the background.`
            : '';

        template = `Professional ecommerce product photo of a plain cotton hoodie in ${hoodieColor}. Front view on ${backgroundColor}. 
    
CRITICAL FABRIC REALISM: Render realistic 3D cotton fabric with natural texture - visible cotton weave, subtle fabric grain, natural cotton matte finish. Show realistic garment structure with proper hood shape, natural fabric folds at elbows and torso, ribbed cuffs and hem with knit texture detail, kangaroo pocket with depth and fabric overlap. The hoodie must look like a real physical cotton garment with dimensional fabric draping and natural material properties.${whiteFabricControl}

LIGHTING RULES (MANDATORY): Flat, uniform, front-facing catalog lighting. ZERO directional lighting, ZERO side lighting, ZERO rim lighting, ZERO global illumination gradients, ZERO ambient occlusion. Fabric brightness must stay uniform across the entire garment and always be brighter than the background everywhere. Do NOT apply left-to-right or top-to-bottom brightness gradients on the garment. Hood interior darkness must not influence exterior fabric brightness. ZERO shadows, ZERO cast shadows, ZERO drop/ground shadows.

BACKGROUND: ${backgroundColor} must be perfectly clean, uniform, and completely free of any shadows or darkening. Pure solid color with zero gradient, zero noise, zero texture.

MATERIAL FINISH: Completely matte cotton fabric. ABSOLUTELY NO shine, NO gloss, NO reflections, NO specularity, NO wet look, NO plastic appearance. Keep natural cotton texture visible.

Keep completely blank and unbranded: NO TEXT, NO LOGOS, NO DESIGN, NO PATTERNS, NO GRAPHICS.`;

        negative =
            'NEGATIVE: shiny, glossy, gloss, shine, specularity, specular, specular highlight, specular reflection, reflective, reflections, reflection, mirror-like, wet look, wet appearance, wet surface, moist appearance, plastic, vinyl, PVC, latex, leather, rubber, satin, silk, lustrous, polished, sheen, glint, sparkle, highlight sparkle, glare, hot spots, blown highlights, overexposed, clipped whites, metallic, pearlescent, iridescent, shimmer, shimmery, glass-like, glazed, lacquered, varnished, coated, smooth plastic, shiny plastic, glossy fabric, reflective fabric, shadow, drop shadow, cast shadow, ground shadow, floor shadow, product shadow, shadow under hoodie, shadow on background, shadow effect, shading on background, background darkening, gradient shadow, vignette, 3D render look, CGI appearance, overly smooth, text, logo, branding, print, pattern, graphic, noise, grain, speckles, salt-and-pepper noise, grainy fabric, noisy fabric, film grain, digital noise, compression artifacts, overexposure, too bright, washed out, flat 2D style, vector graphic, illustration, cartoon, line art, sketch, painting, props, room, scene, people, mannequin.';
    }

    const substituted = template;

    const framing = 'Leave 8-10% margin around hoodie. No cropping.';
    const baseLine = basePrompt ? `User request: ${basePrompt}` : '';
    const brandLine = brandName ? `Brand name: ${brandName}. Do not add extra text.` : '';

    return [substituted, framing, negative, baseLine, brandLine].filter(Boolean).join(' ');
}
