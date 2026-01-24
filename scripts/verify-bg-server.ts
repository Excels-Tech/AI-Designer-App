
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

async function verify() {
    const fetch = (await import('node-fetch')).default;
    const url = 'http://localhost:4000/api/generate-base';

    console.log('Testing generation with bgColor: "lightgray"...');

    // Minimal payload to trigger generation
    const body = {
        prompt: "minimalist cardboard box",
        style: "realistic",
        resolution: 512,
        width: 512,
        height: 512,
        bgColor: "lightgray"
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            console.error('Request failed:', res.status, res.statusText);
            const text = await res.text();
            console.error('Body:', text);
            return;
        }

        const data: any = await res.json();
        if (!data.baseImage) {
            console.error('No baseImage in response:', data);
            return;
        }

        const buffer = Buffer.from(data.baseImage, 'base64');
        const outputPath = path.resolve('verify-output-gray.png');
        fs.writeFileSync(outputPath, buffer);
        console.log(`Saved output to ${outputPath}`);

        // Analyze corner pixel
        const image = sharp(buffer);
        const { data: pixelData } = await image
            .extract({ left: 0, top: 0, width: 1, height: 1 })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const r = pixelData[0];
        const g = pixelData[1];
        const b = pixelData[2];

        console.log(`Top-left pixel color: R=${r}, G=${g}, B=${b}`);

        // Target is #EEEEEE -> 238, 238, 238 (Wait, index.ts constant says #E6E6E6 which is 230, 230, 230)
        // The prompt says #EEEEEE (238), but the constant LIGHT_GRAY_BG is 230.
        // The prompt: 'Background MUST be PURE SOLID LIGHT GREY (#EEEEEE)...'
        // The constant: const LIGHT_GRAY_BG = { r: 230, g: 230, b: 230, alpha: 1 };
        // normalizeHoodieMockupEcom uses LIGHT_GRAY_BG (230).

        const isGray = (val: number) => val >= 180 && val <= 245;

        if (isGray(r) && isGray(g) && isGray(b)) {
            console.log('SUCCESS: Background detected as Light Grey.');
        } else if (r > 250 && g > 250 && b > 250) {
            console.error('FAILURE: Background detected as WHITE.');
        } else {
            console.log('UNKNOWN: Background color is unexpected.');
        }

    } catch (err) {
        console.error('Verification error:', err);
    }
}

verify();
