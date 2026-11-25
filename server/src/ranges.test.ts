import { describe, expect, it } from 'vitest';
import { audioContentType, parseRange } from './ranges';

describe('parseRange', () => {
  it('gives the whole file without a header', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'full' });
  });

  it('reads start-end, start- and -suffix', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseRange('bytes=10-', 100)).toEqual({ kind: 'partial', start: 10, end: 99 });
    expect(parseRange('bytes=-25', 100)).toEqual({ kind: 'partial', start: 75, end: 99 });
    expect(parseRange('Bytes= 5 - 5 ', 100)).toEqual({ kind: 'partial', start: 5, end: 5 });
  });

  it('clamps an end or a suffix past the file', () => {
    expect(parseRange('bytes=90-500', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });

  it('is unsatisfiable past the end, for an empty suffix, and for an empty file', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=250-300', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not understand', () => {
    for (const header of ['items=0-5', 'bytes=0-5,10-15', 'bytes=-', 'bytes=abc', 'bytes=9-3', '']) {
      expect(parseRange(header, 100)).toEqual({ kind: 'full' });
    }
  });
});

describe('audioContentType', () => {
  it('knows every audio extension', () => {
    expect(audioContentType('a.flac')).toBe('audio/flac');
    expect(audioContentType('a.MP3')).toBe('audio/mpeg');
    expect(audioContentType('a.m4a')).toBe('audio/mp4');
    expect(audioContentType('a.aac')).toBe('audio/aac');
    expect(audioContentType('a.ogg')).toBe('audio/ogg');
    expect(audioContentType('a.oga')).toBe('audio/ogg');
    expect(audioContentType('a.opus')).toBe('audio/ogg');
    expect(audioContentType('/music/Disc 1/a.b.wav')).toBe('audio/wav');
    expect(audioContentType('a.txt')).toBe('application/octet-stream');
  });
});
