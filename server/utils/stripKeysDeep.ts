export function stripKeysDeep<T>(input: T, keysToStrip: readonly string[]): T {
  const keys = new Set(keysToStrip.map((k) => String(k)));

  const walk = (value: any): any => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (value instanceof Buffer) return value;

    if (Array.isArray(value)) {
      return value.map((v) => walk(v));
    }

    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };

  return walk(input);
}

