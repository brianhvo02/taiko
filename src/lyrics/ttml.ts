/**
 * Timed lyrics. One format is understood throughout: TTML as Apple Music writes it (word-timed `<span>`s inside
 * line `<p>`s, with romanizations and translations in the head, keyed to each line). An Apple Music lyrics JSON
 * response is a wrapper around that TTML, and an LRC file is converted to it on the way in (`lrc.ts`).
 */
import { lrcToTtml } from './lrc';

export const ITUNES_NS = 'http://music.apple.com/lyric-ttml-internal';

export interface Word {
  kind: 'word';
  text: string;
  begin: number;
  end: number;
}

/** A line is timed words with the spaces between them kept, so "de i" + "kiru" reads "de ikiru". */
export type Piece = Word | { kind: 'space' };

export interface LyricLine {
  begin: number;
  end: number;
  original: Piece[];
  roman: Piece[] | null;
  /** One untimed sentence, or '' when the file has no translation of this line. */
  translation: string;
}

export interface SongPart {
  /** "Verse", "Chorus", "Pre-chorus"…, or '' when the file doesn't say. */
  name: string;
  lines: LyricLine[];
}

export interface Song {
  parts: SongPart[];
  language: string;
  translationLanguage: string;
  writers: string[];
  hasRoman: boolean;
  hasTranslation: boolean;
  /**
   * Whether the words have their own timings. False when the file only says when each line starts and ends: a
   * plain LRC file, or Apple's line-timed lyrics. Such a line lights up whole; it is not swept word by word.
   */
  wordTimed: boolean;
}

/** An open lyrics file: the TTML document, and the JSON it came wrapped in, if any. */
export interface LyricsSource {
  doc: Document;
  wrapper: unknown;
  /** Where the TTML text sits inside `wrapper`. */
  place: { holder: Record<string, unknown>; key: string } | null;
  /** The Apple Music song ID, when the file carries one. */
  catalogId: string;
  /** The files this source was read from; more than one after a merge. */
  names: string[];
}

export const all = (root: Document | Element, name: string): Element[] => Array.from(root.getElementsByTagNameNS('*', name));
export const childNamed = (parent: Element, name: string): Element | null =>
  Array.from(parent.children).find((child) => child.localName === name) ?? null;

/** Reads "5.470", "1:11.996" and "1:02:03.5" as seconds. */
export function parseTime(value: string | null): number {
  if (!value) return NaN;
  return value.trim().split(':').reduce((total, part) => total * 60 + parseFloat(part), 0);
}

function pieces(node: Element, begin: number, end: number, out: Piece[] = []): Piece[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.nodeValue ?? '';
      if (text.trim()) out.push({ kind: 'word', text, begin, end });
      else if (text) out.push({ kind: 'space' });
    } else if (child.nodeType === 1) {
      const el = child as Element;
      const b = parseTime(el.getAttribute('begin'));
      const e = parseTime(el.getAttribute('end'));
      const ownBegin = Number.isNaN(b) ? begin : b;
      const ownEnd = Number.isNaN(e) ? end : e;
      if (el.children.length) pieces(el, ownBegin, ownEnd, out);
      else if (el.textContent) out.push({ kind: 'word', text: el.textContent, begin: ownBegin, end: ownEnd });
    }
  }
  return out;
}

/** Builds the song a document describes. Throws when it has no timed lines. */
export function songFromDoc(doc: Document): Song {
  const body = all(doc, 'body')[0];
  if (!body) throw new Error('no body');

  const romanByKey = new Map<string, Element>();
  for (const entry of all(doc, 'transliteration').flatMap((t) => all(t, 'text'))) {
    const key = entry.getAttribute('for');
    if (key && !romanByKey.has(key)) romanByKey.set(key, entry);
  }
  const translation = all(doc, 'translation')[0];
  const translationByKey = new Map<string, string>();
  for (const entry of translation ? all(translation, 'text') : []) {
    const key = entry.getAttribute('for');
    const sentence = (entry.textContent ?? '').trim();
    if (key && sentence) translationByKey.set(key, sentence);
  }

  const parts: (SongPart & { node: Node | null })[] = [];
  for (const p of all(body, 'p')) {
    const begin = parseTime(p.getAttribute('begin'));
    if (Number.isNaN(begin)) continue;
    const end = parseTime(p.getAttribute('end'));
    const lineEnd = Number.isNaN(end) ? begin + 5 : end;
    const key = p.getAttribute('itunes:key') ?? '';
    const romanEntry = romanByKey.get(key);
    let part = parts[parts.length - 1];
    if (!part || part.node !== p.parentNode) {
      const name = (p.parentNode as Element | null)?.getAttribute?.('itunes:songPart') ?? '';
      part = { node: p.parentNode, name: name.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a}-${b.toLowerCase()}`), lines: [] };
      parts.push(part);
    }
    part.lines.push({
      begin,
      end: lineEnd,
      original: pieces(p, begin, lineEnd),
      roman: romanEntry ? pieces(romanEntry, begin, lineEnd) : null,
      translation: translationByKey.get(key) ?? '',
    });
  }
  if (!parts.length) throw new Error('no timed lines');

  const lines = parts.flatMap((part) => part.lines);
  return {
    parts: parts.map(({ name, lines: partLines }) => ({ name, lines: partLines })),
    language: doc.documentElement.getAttribute('xml:lang') ?? '',
    translationLanguage: translation?.getAttribute('xml:lang') ?? '',
    writers: all(doc, 'songwriter').map((w) => (w.textContent ?? '').trim()).filter(Boolean),
    hasRoman: lines.some((line) => line.roman),
    hasTranslation: lines.some((line) => line.translation),
    // Word-timed when any word in the song starts or ends at a time that isn't its line's.
    wordTimed: lines.some((line) => line.original.some((piece) => piece.kind === 'word' && (piece.begin !== line.begin || piece.end !== line.end))),
  };
}

function locateTtml(value: unknown): LyricsSource['place'] {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        if (child.includes('<tt')) return { holder: value as Record<string, unknown>, key };
      } else {
        const found = locateTtml(child);
        if (found) return found;
      }
    }
  }
  return null;
}

function findValue(value: unknown, wanted: string): string {
  if (value && typeof value === 'object') {
    const own = (value as Record<string, unknown>)[wanted];
    if (!Array.isArray(value) && (typeof own === 'string' || typeof own === 'number')) return String(own);
    for (const child of Object.values(value)) {
      const found = findValue(child, wanted);
      if (found) return found;
    }
  }
  return '';
}

const looksLikeLrc = (text: string) => /^\s*\[(\d+:\d|[a-z]+:)/im.test(text);

/** Opens one lyrics file (Apple Music JSON, TTML or LRC). Throws when it holds no timed lyrics. */
export function openLyrics(text: string, name: string): LyricsSource {
  const trimmed = text.replace(/^﻿/, '').trim();
  let wrapper: unknown = null;
  let place: LyricsSource['place'] = null;
  let xml = trimmed;
  if (trimmed.startsWith('{') || (trimmed.startsWith('[') && !looksLikeLrc(trimmed))) {
    wrapper = JSON.parse(trimmed);
    place = locateTtml(wrapper);
    if (!place) throw new Error('no TTML in JSON');
    xml = place.holder[place.key] as string;
  } else if (!trimmed.startsWith('<')) {
    xml = lrcToTtml(trimmed);
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid XML');
  songFromDoc(doc);
  const id = wrapper ? findValue(wrapper, 'catalogId') : '';
  return { doc, wrapper, place, catalogId: /^\d+$/.test(id) ? id : '', names: [name] };
}
