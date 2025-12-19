export function getUserId(): string {
  if (typeof window === 'undefined') return 'anonymous';
  const urlUid = new URLSearchParams(window.location.search).get('uid');
  if (urlUid && urlUid.length <= 128) {
    localStorage.setItem('user-id', urlUid);
    return urlUid;
  }
  const existing = localStorage.getItem('user-id');
  if (existing) return existing;
  const generated = `user-${crypto.randomUUID()}`;
  localStorage.setItem('user-id', generated);
  return generated;
}

export function getApiBaseUrl(): string {
  const base = (import.meta as any)?.env?.VITE_API_BASE_URL as string | undefined;
  if (!base) return '';
  return base.replace(/\/+$/, '');
}

function resolveApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== 'string') return input;
  if (/^https?:\/\//i.test(input) || input.startsWith('blob:') || input.startsWith('data:')) {
    return input;
  }
  const base = getApiBaseUrl();
  if (!base) return input;
  return `${base}${input.startsWith('/') ? '' : '/'}${input}`;
}

export function resolveApiAssetUrl(input: string): string {
  const resolved = resolveApiUrl(input);
  return typeof resolved === 'string' ? resolved : input;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit) {
  const uid = getUserId();
  const headers = new Headers(init?.headers || {});
  headers.set('x-user-id', uid);
  return fetch(resolveApiUrl(input), { ...init, headers });
}
