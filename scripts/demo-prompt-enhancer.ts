
import { enhancePrompt } from '../server/promptEnhancer';

const simplePrompts = [
    "create a post we are hiring AI Engineer",
    "a cute cat in space",
    "minimalist logo for a coffee shop"
];

console.log("\n--- PROMTP ENHANCER DEMO ---\n");

simplePrompts.forEach(prompt => {
    console.log(`Original: "${prompt}"`);
    // Using the same settings as the server (creativity: 0.75)
    const result = enhancePrompt(prompt, { creativity: 0.75 });
    console.log(`Enhanced: "${result.enhancedPrompt}"`);
    console.log("-".repeat(40));
});
