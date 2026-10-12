// Versioned, failure-tolerant persistence on top of localStorage.
export const ROOT_PREFIX = 'jsonworld:';
export const VERSION = 1;
export const PREFIX = `${ROOT_PREFIX}v${VERSION}:`;

export type SaveStatus = { key: string; ok: boolean; reason?: 'quota' | 'error' };
type Listener = (s: SaveStatus) => void;

export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; code?: number };
  return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014;
}

/** Returns a usable Storage, or null when unavailable (private mode, disabled, sandboxed). */
export function probeStorage(get: () => Storage | undefined = () => (typeof window !== 'undefined' ? window.localStorage : undefined)): Storage | null {
  try {
    const s = get();
    if (!s) return null;
    const k = `${ROOT_PREFIX}__probe__`;
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export class Persist {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, unknown>();
  private listeners = new Set<Listener>();
  private disabled = false;
  /** Keys whose last save failed (value kept in memory only). */
  readonly failed = new Map<string, SaveStatus['reason']>();

  constructor(readonly store: Storage | null, readonly delay = 300) {}

  get available() { return !!this.store; }

  /** Read and validate a value; any missing / corrupted / invalid data yields undefined. */
  load<T>(key: string, validate: (x: unknown) => T | undefined): T | undefined {
    if (!this.store) return undefined;
    try {
      const raw = this.store.getItem(PREFIX + key);
      if (raw === null) return undefined;
      return validate(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** Debounced save. */
  save(key: string, value: unknown) {
    if (this.disabled || !this.store) return;
    this.pending.set(key, value);
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(key, setTimeout(() => this.write(key), this.delay));
  }

  /** Write all pending values immediately. */
  flush() {
    for (const key of [...this.pending.keys()]) this.write(key);
  }

  private write(key: string) {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    if (!this.pending.has(key)) return;
    const value = this.pending.get(key);
    this.pending.delete(key);
    if (this.disabled || !this.store) return;
    let status: SaveStatus;
    try {
      this.store.setItem(PREFIX + key, JSON.stringify(value));
      this.failed.delete(key);
      status = { key, ok: true };
    } catch (e) {
      const reason = isQuotaError(e) ? 'quota' : 'error';
      this.failed.set(key, reason);
      // don't leave a stale older copy that would be restored later
      try { this.store.removeItem(PREFIX + key); } catch { /* ignore */ }
      status = { key, ok: false, reason };
    }
    this.listeners.forEach(l => l(status));
  }

  onStatus(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  /** Remove every json-world key (all versions) and stop saving until reload. */
  clearAll() {
    this.disabled = true;
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear(); this.pending.clear(); this.failed.clear();
    if (!this.store) return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.store.length; i++) { const k = this.store.key(i); if (k && k.startsWith(ROOT_PREFIX)) keys.push(k); }
      keys.forEach(k => this.store!.removeItem(k));
    } catch { /* ignore */ }
  }
}

// ---------- validators ----------
export const isStr = (x: unknown): x is string => typeof x === 'string';
export const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
export const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const oneOf = <T extends string>(vals: readonly T[]) => (x: unknown): x is T => typeof x === 'string' && (vals as readonly string[]).includes(x);
/** Keep only fields of `x` that pass their checker; fall back to defaults for the rest. */
export function pick<T extends object>(x: unknown, defaults: T, checks: { [K in keyof T]: (v: unknown) => boolean }): T | undefined {
  if (!isObj(x)) return undefined;
  const out = { ...defaults };
  for (const k of Object.keys(checks) as (keyof T)[]) if (k in x && checks[k]((x as any)[k])) (out as any)[k] = (x as any)[k];
  return out;
}

// ---------- app singleton ----------
export const persist = new Persist(probeStorage());
if (typeof window !== 'undefined') {
  const flush = () => persist.flush();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
