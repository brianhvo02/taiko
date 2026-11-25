// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { lrcToTtml } from './lrc';
import { mergeInto, sameSong, serialize } from './merge';
import { openLyrics, parseTime, songFromDoc } from './ttml';
import type { Piece } from './ttml';

// Made-up lyrics in the shape Apple Music serves them.
const HEAD_OPEN = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="ja"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">';
const BODY = '<body dur="1:20.000"><div begin="1.000" end="6.000" itunes:songPart="Verse"><p begin="1.000" end="3.000" itunes:key="L1" ttm:agent="v1"><span begin="1.000" end="2.000">紙の</span><span begin="2.000" end="3.000">灯籠</span></p><p begin="3.000" end="6.000" itunes:key="L2" ttm:agent="v1"><span begin="3.000" end="4.500">夜を</span> <span begin="4.500" end="6.000">渡る</span></p></div><div begin="1:10.000" end="1:15.000" itunes:songPart="PreChorus"><p begin="1:10.000" end="1:15.000" itunes:key="L3" ttm:agent="v1"><span begin="1:10.000" end="1:15.000">また明日</span></p></div></body></tt>';
const WRITERS = '<songwriters><songwriter>Midori Vale</songwriter></songwriters>';
const ROMAN = '<transliterations><transliteration xml:lang="ja-Latn"><text for="L1"><span begin="1.000" end="2.000" xmlns="http://www.w3.org/ns/ttml">kami no</span> <span begin="2.000" end="3.000" xmlns="http://www.w3.org/ns/ttml">tourou</span></text><text for="L2"><span begin="3.000" end="4.500" xmlns="http://www.w3.org/ns/ttml">yoru o</span> <span begin="4.500" end="6.000" xmlns="http://www.w3.org/ns/ttml">wataru</span></text><text for="L3"><span begin="1:10.000" end="1:15.000" xmlns="http://www.w3.org/ns/ttml">mata ashita</span></text></transliteration></transliterations>';
const ENGLISH = '<translations><translation type="subtitle" xml:lang="en-US"><text for="L1">Paper lanterns</text><text for="L2">Crossing the night</text><text for="L3">See you tomorrow</text></translation></translations>';
const HEAD_CLOSE = '</iTunesMetadata></metadata></head>';

const ttml = (...head: string[]) => HEAD_OPEN + head.join('') + HEAD_CLOSE + BODY;
const wrap = (xml: string) => JSON.stringify({ data: [{ id: '123456', type: 'syllable-lyrics', attributes: { playParams: { catalogId: '123456' }, ttmlLocalizations: xml } }] });
const text = (list: Piece[]) => list.map((piece) => (piece.kind === 'word' ? piece.text : ' ')).join('');

describe('parseTime', () => {
  it('reads seconds, minutes and hours', () => {
    expect(parseTime('5.470')).toBeCloseTo(5.47);
    expect(parseTime('1:11.996')).toBeCloseTo(71.996);
    expect(parseTime('1:02:03.5')).toBeCloseTo(3723.5);
    expect(parseTime(null)).toBeNaN();
  });
});

describe('openLyrics', () => {
  it('reads an Apple Music JSON response with its song ID', () => {
    const source = openLyrics(wrap(ttml('<translations/>', WRITERS, ROMAN)), 'song.json');
    expect(source.catalogId).toBe('123456');
    const song = songFromDoc(source.doc);
    expect(song.language).toBe('ja');
    expect(song.writers).toEqual(['Midori Vale']);
    expect(song.parts.map((part) => part.name)).toEqual(['Verse', 'Pre-chorus']);
    expect(song.hasRoman).toBe(true);
    expect(song.hasTranslation).toBe(false);
    expect(song.wordTimed).toBe(true);
    const [first, second] = song.parts[0].lines;
    expect(first.original).toEqual([
      { kind: 'word', text: '紙の', begin: 1, end: 2 },
      { kind: 'word', text: '灯籠', begin: 2, end: 3 },
    ]);
    expect(text(second.original)).toBe('夜を 渡る');
    expect(text(first.roman ?? [])).toBe('kami no tourou');
    expect(song.parts[1].lines[0].begin).toBe(70);
  });

  it('reads a plain TTML file, which has no song ID', () => {
    const source = openLyrics(ttml(ENGLISH), 'song.ttml');
    expect(source.catalogId).toBe('');
    const song = songFromDoc(source.doc);
    expect(song.translationLanguage).toBe('en-US');
    expect(song.parts[0].lines[1].translation).toBe('Crossing the night');
  });

  it("reads Apple's line-timed response, where the TTML sits under ttml and lines have no word spans", () => {
    const lineTimed = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Line" xml:lang="ja"><head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters><songwriter>Midori Vale</songwriter></songwriters></iTunesMetadata></metadata></head><body dur="0:20.000"><div begin="1.000" end="9.000" itunes:songPart="Verse"><p begin="1.000" end="5.000" itunes:key="L1">紙の灯籠</p><p begin="5.000" end="9.000" itunes:key="L2">夜を渡る</p></div></body></tt>';
    const source = openLyrics(JSON.stringify({ data: [{ id: '777', type: 'lyrics', attributes: { ttml: lineTimed, playParams: { id: 'AP_777', kind: 'lyric', catalogId: '777', displayType: 2 } } }] }), 'song.json');
    expect(source.catalogId).toBe('777');
    const song = songFromDoc(source.doc);
    expect(song.hasRoman || song.hasTranslation).toBe(false);
    // Each line is one stretch of text with the line's own times: timed by line, not by word.
    expect(song.wordTimed).toBe(false);
    expect(song.writers).toEqual(['Midori Vale']);
    expect(song.parts[0].lines.map((line) => line.original)).toEqual([
      [{ kind: 'word', text: '紙の灯籠', begin: 1, end: 5 }],
      [{ kind: 'word', text: '夜を渡る', begin: 5, end: 9 }],
    ]);
  });

  it('refuses files without timed lyrics', () => {
    expect(() => openLyrics('{"data":[]}', 'empty.json')).toThrow();
    expect(() => openLyrics('<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>', 'empty.ttml')).toThrow();
    expect(() => openLyrics('just some words', 'notes.txt')).toThrow();
  });
});

describe('combining versions', () => {
  it('merges a romanization and a translation into the plain version and saves one file', () => {
    const base = openLyrics(wrap(ttml('<translations/>', WRITERS)), 'plain.json');
    const roman = openLyrics(wrap(ttml('<translations/>', WRITERS, ROMAN)), 'roman.json');
    const english = openLyrics(wrap(ttml(ENGLISH, WRITERS)), 'english.json');
    expect(sameSong(base, roman)).toBe(true);
    mergeInto(base, roman);
    mergeInto(base, english);
    mergeInto(base, english); // a second time adds nothing
    expect(base.names).toEqual(['plain.json', 'roman.json', 'english.json']);

    const saved = serialize(base);
    expect(saved.extension).toBe('json');
    const reopened = openLyrics(saved.text, 'combined.json');
    expect(sameSong(reopened, roman)).toBe(true);
    const song = songFromDoc(reopened.doc);
    expect(song.hasRoman && song.hasTranslation).toBe(true);
    expect(reopened.doc.getElementsByTagNameNS('*', 'translation')).toHaveLength(1);
    expect(reopened.doc.getElementsByTagNameNS('*', 'transliteration')).toHaveLength(1);
    expect(song.parts[1].lines[0].translation).toBe('See you tomorrow');
  });

  it('tells different songs apart', () => {
    const other = openLyrics(ttml().replace('紙の', '石の'), 'other.ttml');
    expect(sameSong(openLyrics(ttml(), 'song.ttml'), other)).toBe(false);
  });

  it('saves plain TTML when no file came wrapped in JSON', () => {
    const base = openLyrics(ttml(), 'a.ttml');
    mergeInto(base, openLyrics(ttml(ENGLISH), 'b.ttml'));
    const saved = serialize(base);
    expect(saved.extension).toBe('ttml');
    expect(songFromDoc(openLyrics(saved.text, 'c.ttml').doc).hasTranslation).toBe(true);
  });
});

describe('LRC', () => {
  it('turns lines into timed lines that end where the next begins', () => {
    const song = songFromDoc(openLyrics('[ti:Paper Lanterns]\n[00:01.00]Paper lanterns\n[00:03.50]Crossing the night\n[00:06.00]\n', 'song.lrc').doc);
    const lines = song.parts[0].lines;
    expect(song.wordTimed).toBe(false);
    expect(lines.map((line) => [line.begin, line.end, text(line.original)])).toEqual([
      [1, 3.5, 'Paper lanterns'],
      [3.5, 6, 'Crossing the night'],
    ]);
  });

  it('keeps word timings from enhanced LRC and repeats a line with several time tags', () => {
    const xml = lrcToTtml('[00:10.00]<00:10.00>one <00:10.50>two\n[00:20.00][00:30.00]again\n[offset:500]');
    const song = songFromDoc(openLyrics(xml, 'song.ttml').doc);
    const lines = song.parts[0].lines;
    expect(song.wordTimed).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[0].original).toEqual([
      { kind: 'word', text: 'one', begin: 9.5, end: 10 },
      { kind: 'space' },
      { kind: 'word', text: 'two', begin: 10, end: 19.5 },
    ]);
    expect(lines[1].begin).toBe(19.5);
    expect(lines[2].begin).toBe(29.5);
  });
});
