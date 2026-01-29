export const NO_BRANDING_BLOCK_POSITIVE = [
  'ABSOLUTELY NO text, letters, words, numbers, typography, watermarks, slogans, brand names, logos, trademarks, labels, tags, emblems, stamps, signatures.',
  'No UI overlays. No corner badges. No mockup brand marks.',
  'If ANY text or logo appears anywhere in the frame, the output is invalid.',
].join(' ');

export const NO_BRANDING_BLOCK_NEGATIVE =
  'NEGATIVE: text, letters, words, numbers, typography, watermark, signature, brand, brand name, logo, trademark, label, tag, emblem, stamp, slogan, badge, corner overlay, UI overlay.';

// Allow branding only if the user explicitly asks to ADD/INCLUDE branding/text.
// Important: do NOT treat "no text/no logo/no branding" as branding intent.
export function allowBranding(userPrompt: string): boolean {
  const s = String(userPrompt ?? '').trim();
  if (!s) return false;
  const t = s.toLowerCase();

  // Explicit prohibition overrides everything.
  const forbids = /\b(no|without|avoid|remove|exclude)\s+(brand|branding|logo|logos|brand\s*name|wordmark|watermark|signature|text|letters|words|numbers|typography|label|tag|emblem|badge|crest|sponsor|patch)\b/;
  if (forbids.test(t)) return false;
  if (/\bunbranded\b|\bblank\b|\bno\s+branding\b/.test(t)) return false;

  // Positive intent: user wants branding/text added.
  const wants = /\b(logo|brand\s*name|wordmark|logotype|trademark|watermark|typography|lettering|text|numbers?)\b/;
  const intentVerbs = /\b(add|with|include|including|put|place|print|apply|use|insert|write|spell|show|set)\b/;
  if (intentVerbs.test(t) && wants.test(t)) return true;

  // Common direct requests (e.g. "make a logo for X").
  if (/\b(make|create|design|generate)\b.{0,20}\b(logo|wordmark|logotype)\b/.test(t)) return true;
  if (/\b(logo|wordmark|logotype)\b.{0,10}\bfor\b/.test(t)) return true;
  if (/\badd\b.{0,20}\b(my|our|company|brand)\b/.test(t)) return true;

  return false;
}

