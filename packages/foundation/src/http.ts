// Minimal JSON-over-HTTP helper with timeouts and typed errors.

import { PortError, TimeoutPortError, UnreachableError } from './errors.js';

export interface HttpOptions {
  timeoutMs?: number;
  token?: string;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function request<T>(url: string, init: RequestInit, what: string, opts: HttpOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new TimeoutPortError(what, timeoutMs);
    throw new UnreachableError(url);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new PortError('BAD_JSON', `${what}: non-JSON response`, res.status);
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | undefined)?.error ?? res.statusText;
    throw new PortError('HTTP_' + res.status, `${what}: ${msg}`, res.status);
  }
  if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false) {
    const msg = (body as { error?: string }).error ?? 'mod error';
    throw new PortError('MOD_ERROR', `${what}: ${msg}`, res.status);
  }
  return body as T;
}

export function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  return request<T>(url, { method: 'GET', headers: headers(opts.token) }, 'GET ' + url, opts);
}

export function postJson<T = unknown>(url: string, body: unknown, opts: HttpOptions = {}): Promise<T> {
  return request<T>(
    url,
    { method: 'POST', headers: { ...headers(opts.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    'POST ' + url,
    opts,
  );
}
