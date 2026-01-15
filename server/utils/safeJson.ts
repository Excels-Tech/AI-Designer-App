import type { Response } from 'express';
import { stripKeysDeep } from './stripKeysDeep';

const LEAK_KEYS = ['enhancedPrompt', 'negativePrompt'] as const;

export function safeJson(res: Response, payload: unknown, status?: number) {
  const sanitized = stripKeysDeep(payload, LEAK_KEYS);
  if (typeof status === 'number') {
    return res.status(status).json(sanitized);
  }
  return res.json(sanitized);
}

