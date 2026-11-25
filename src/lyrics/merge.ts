/**
 * Combining versions of one song's lyrics. Apple serves the same timed lines once per extra (a romanization, a
 * translation); the extras live in the head, keyed to the lines, so two files of the same song merge by copying
 * the head entries one of them lacks.
 */
import { ITUNES_NS, all, childNamed } from './ttml';
import type { LyricsSource } from './ttml';

/** Two files are versions of the same song when their timed lines are identical. */
export function lineSignature(doc: Document): string {
  const body = all(doc, 'body')[0];
  if (!body) return '';
  return all(body, 'p')
    .map((p) => `${p.getAttribute('itunes:key')}|${p.getAttribute('begin')}|${p.getAttribute('end')}|${p.textContent}`)
    .join('\n');
}

export const sameSong = (a: LyricsSource, b: LyricsSource): boolean => lineSignature(a.doc) === lineSignature(b.doc);

function ensureChild(parent: Element, namespace: string | null, name: string, atStart: boolean): Element {
  let el = childNamed(parent, name);
  if (!el) {
    el = parent.ownerDocument.createElementNS(namespace, name);
    if (atStart) parent.prepend(el);
    else parent.append(el);
  }
  return el;
}

/** Copies into `base` the translations and romanizations (one per language) that only `extra` has. */
export function mergeInto(base: LyricsSource, extra: LyricsSource): void {
  const extraMeta = all(extra.doc, 'iTunesMetadata')[0];
  if (extraMeta) {
    const root = base.doc.documentElement;
    const head = ensureChild(root, root.namespaceURI, 'head', true);
    const metadata = ensureChild(head, root.namespaceURI, 'metadata', true);
    const meta = ensureChild(metadata, ITUNES_NS, 'iTunesMetadata', false);
    for (const group of ['translations', 'transliterations']) {
      const from = childNamed(extraMeta, group);
      if (!from) continue;
      for (const entry of Array.from(from.children)) {
        const to = ensureChild(meta, ITUNES_NS, group, group === 'translations');
        const language = entry.getAttribute('xml:lang');
        const present = Array.from(to.children).some((c) => c.localName === entry.localName && c.getAttribute('xml:lang') === language);
        if (!present) to.append(base.doc.importNode(entry, true));
      }
    }
    const writers = childNamed(extraMeta, 'songwriters');
    if (writers && !childNamed(meta, 'songwriters')) meta.append(base.doc.importNode(writers, true));
  }
  if (!base.wrapper && extra.wrapper) {
    base.wrapper = extra.wrapper;
    base.place = extra.place;
  }
  if (!base.catalogId) base.catalogId = extra.catalogId;
  for (const name of extra.names) if (!base.names.includes(name)) base.names.push(name);
}

export interface SavedLyrics {
  text: string;
  extension: 'json' | 'ttml';
  type: string;
}

/** The source as one file: the Apple JSON wrapper when any of its files had one, plain TTML otherwise. */
export function serialize(source: LyricsSource): SavedLyrics {
  const xml = new XMLSerializer().serializeToString(source.doc);
  if (source.wrapper && source.place) {
    source.place.holder[source.place.key] = xml;
    return { text: JSON.stringify(source.wrapper, null, 4), extension: 'json', type: 'application/json' };
  }
  return { text: xml, extension: 'ttml', type: 'application/ttml+xml' };
}
