import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Persist, PREFIX, ROOT_PREFIX, probeStorage, isQuotaError, pick, isStr, isBool, oneOf } from './storage';

class MemStorage implements Storage {
  m = new Map<string, string>();
  quota = Infinity;
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) {
    const used = [...this.m].reduce((s, [a, b]) => s + (a === k ? 0 : a.length + b.length), 0);
    if (used + k.length + v.length > this.quota) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, v);
  }
}

describe('storage layer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round trip with versioned key, debounced', () => {
    const s = new MemStorage(); const p = new Persist(s, 300);
    p.save('viewer', { text: '{"a":1}', indent: 4 });
    expect(s.getItem(PREFIX + 'viewer')).toBeNull();
    vi.advanceTimersByTime(299); expect(s.getItem(PREFIX + 'viewer')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(PREFIX).toBe('jsonworld:v1:');
    expect(JSON.parse(s.getItem('jsonworld:v1:viewer')!)).toEqual({ text: '{"a":1}', indent: 4 });
    expect(new Persist(s).load('viewer', x => x)).toEqual({ text: '{"a":1}', indent: 4 });
  });
  it('debounce coalesces and flush writes immediately', () => {
    const s = new MemStorage(); const p = new Persist(s, 300); const spy = vi.spyOn(s, 'setItem');
    p.save('k', 1); p.save('k', 2); p.save('k', 3);
    p.flush();
    expect(spy).toHaveBeenCalledTimes(1); expect(s.getItem(PREFIX + 'k')).toBe('3');
    vi.advanceTimersByTime(1000); expect(spy).toHaveBeenCalledTimes(1);
  });
  it('ignores other versions and corrupted data', () => {
    const s = new MemStorage(); const p = new Persist(s);
    s.setItem('jsonworld:v0:viewer', '{"text":"old"}');
    expect(p.load('viewer', x => x)).toBeUndefined();
    s.setItem(PREFIX + 'viewer', '{not json');
    expect(p.load('viewer', x => x)).toBeUndefined();
    s.setItem(PREFIX + 'viewer', '[1,2]');
    expect(p.load('viewer', x => pick(x, { text: '' }, { text: isStr }))).toBeUndefined();
  });
  it('validators keep valid fields and default the rest', () => {
    const v = pick({ text: 5, indent: 4, mode: 'weird', on: true }, { text: 'd', indent: 2, mode: 'a' as 'a' | 'b', on: false },
      { text: isStr, indent: (x: unknown) => x === 2 || x === 4, mode: oneOf(['a', 'b'] as const), on: isBool });
    expect(v).toEqual({ text: 'd', indent: 4, mode: 'a', on: true });
  });
  it('quota exceeded: keeps memory, reports, removes stale copy, recovers later', () => {
    const s = new MemStorage(); s.quota = 1000; const p = new Persist(s, 10);
    const statuses: unknown[] = []; p.onStatus(st => statuses.push(st));
    p.save('big', 'small'); p.flush();
    expect(s.getItem(PREFIX + 'big')).toBe('"small"');
    p.save('big', 'x'.repeat(5000)); p.flush();
    expect(statuses.at(-1)).toEqual({ key: 'big', ok: false, reason: 'quota' });
    expect(p.failed.get('big')).toBe('quota');
    expect(s.getItem(PREFIX + 'big')).toBeNull(); // no stale value restored later
    p.save('big', 'fits'); p.flush();
    expect(statuses.at(-1)).toEqual({ key: 'big', ok: true }); expect(p.failed.has('big')).toBe(false);
  });
  it('storage unavailable (private mode / disabled) is a safe no-op', () => {
    const throwing = { setItem() { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(probeStorage(() => throwing)).toBeNull();
    expect(probeStorage(() => { throw new Error('denied'); })).toBeNull();
    expect(probeStorage(() => undefined)).toBeNull();
    const p = new Persist(null);
    expect(p.available).toBe(false);
    expect(() => { p.save('a', 1); p.flush(); }).not.toThrow();
    expect(p.load('a', x => x)).toBeUndefined();
  });
  it('getItem throwing is treated as missing', () => {
    const s = new MemStorage(); s.getItem = () => { throw new Error('boom'); };
    expect(new Persist(s).load('x', v => v)).toBeUndefined();
  });
  it('clearAll removes all json-world keys (every version), keeps others, and stops saving', () => {
    const s = new MemStorage(); const p = new Persist(s, 10);
    s.setItem('jsonworld:v0:x', '1'); s.setItem(PREFIX + 'y', '2'); s.setItem('other', '3');
    p.save('z', 1);
    p.clearAll();
    expect([...s.m.keys()]).toEqual(['other']);
    p.save('z', 2); p.flush(); vi.advanceTimersByTime(100);
    expect(s.getItem(PREFIX + 'z')).toBeNull();
    expect(ROOT_PREFIX).toBe('jsonworld:');
  });
  it('isQuotaError variants', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
  });
});
