
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function testModel(modelName: string) {
    console.log(`Testing image generation with model: ${modelName}`);
    try {
        const response = await openai.images.generate({
            model: modelName,
            prompt: "A simple red circle",
            n: 1,
            size: "1024x1024",
        });
        console.log(`[SUCCESS] Model ${modelName} worked!`);
    } catch (err: any) {
        console.log(`[FAILED] Model ${modelName}:`, err.message);
    }
}

async function run() {
    await testModel('gpt-4o');
    await testModel('dall-e-3');
}

run();
