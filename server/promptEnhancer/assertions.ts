import { isProductionEnv, isPromptEnhancerEnabled } from './runtime';

export function assertPromptEnhancerSelectionDevOnly(args: {
  label: string;
  userPrompt: string;
  promptForModel: string;
  modelText: string;
}) {
  if (isProductionEnv()) return;

  const userPrompt = (args.userPrompt ?? '').trim();
  if (!userPrompt) return;

  const enabled = isPromptEnhancerEnabled();
  const modelText = normalizeWhitespace(args.modelText ?? '');
  const promptForModel = normalizeWhitespace((args.promptForModel ?? '').trim());

  if (!modelText || !promptForModel) return;

  if (!enabled) {
    if (args.promptForModel !== userPrompt) {
      throw new Error(
        `[PromptEnhancer:${args.label}] Expected raw prompt to be sent to model when disabled.`
      );
    }
    if (!modelText.includes(normalizeWhitespace(userPrompt))) {
      throw new Error(
        `[PromptEnhancer:${args.label}] Expected modelText to be constructed from the raw prompt when disabled.`
      );
    }
    return;
  }

  // When enabled, verify selection correctness: the Gemini request text must be constructed from
  // the prompt returned by maybeEnhancePrompt (even if it happens to be unchanged).
  if (!modelText.includes(promptForModel)) {
    throw new Error(
      `[PromptEnhancer:${args.label}] Expected modelText to be constructed from promptForModel when enabled.`
    );
  }
}

function normalizeWhitespace(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
