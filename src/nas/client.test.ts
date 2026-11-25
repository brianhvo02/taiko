import { describe, expect, it } from 'vitest';
import { normalizeBase, parsePairLink } from './client';

describe('normalizeBase', () => {
  it('accepts https, and http only on this machine', () => {
    expect(normalizeBase('https://nas.example.com/taiko/api')).toBe('https://nas.example.com/taiko/api/');
    expect(normalizeBase(' https://nas.example.com/api/?x=1#y ')).toBe('https://nas.example.com/api/');
    expect(normalizeBase('http://localhost:4193/api/')).toBe('http://localhost:4193/api/');
    expect(normalizeBase('http://nas.example.com/api/')).toBeNull();
    expect(normalizeBase('https://user:pw@nas.example.com/api/')).toBeNull();
    expect(normalizeBase('javascript:alert(1)')).toBeNull();
    expect(normalizeBase('nas')).toBeNull();
  });
});

describe('parsePairLink', () => {
  it('reads the server and the code from an invite link', () => {
    const hash = `#pair=${encodeURIComponent('https://nas.example.com/api/')}&code=ABCD-EFGH-JKLM`;
    expect(parsePairLink(hash)).toEqual({ base: 'https://nas.example.com/api/', code: 'ABCD-EFGH-JKLM' });
  });

  it('ignores anything else', () => {
    expect(parsePairLink('')).toBeNull();
    expect(parsePairLink('#code=ABCD')).toBeNull();
    expect(parsePairLink(`#pair=${encodeURIComponent('http://evil.example/api/')}&code=A`)).toBeNull();
  });
});
