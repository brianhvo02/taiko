import { describe, expect, it } from 'vitest';
import { pathOfTrackId, trackIdOf } from '../../src/shared/api';
import { decodeTrackId, encodeTrackId } from './paths';

// The player writes track ids too (a link names a song by its path), so both sides must spell them the same way.
describe('track ids, as the player and the server write them', () => {
  const paths = ['Music/a.flac', 'Downloads/[2026.10.14] 夜市 #1 100%?／Night Market/01. 紙の灯籠.flac', 'M/??>>~~.flac', 'M/a/b/c/d e f.mp3'];

  it('agree in both directions', () => {
    for (const path of paths) {
      const [root, ...parts] = path.split('/');
      expect(trackIdOf(path)).toBe(encodeTrackId(root, parts));
      expect(decodeTrackId(trackIdOf(path))).toBe(path);
      expect(pathOfTrackId(encodeTrackId(root, parts))).toBe(path);
    }
  });
});
