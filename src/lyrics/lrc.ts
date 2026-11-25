/**
 * LRC to TTML. A plain LRC line (`[00:12.34]words`) becomes one timed line that ends where the next begins. The
 * "enhanced" form with word tags (`[00:12.34]<00:12.34>one <00:12.90>two`) keeps its word timings. `[offset:±ms]`
 * is applied; the other header tags (`[ar:]`, `[ti:]`…) are ignored.
 */

const LINE = /^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/;
const STAMP = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
const WORD_TAG = /<(\d+):(\d+)(?:[.:](\d+))?>/g;

const seconds = (minutes: string, secs: string, fraction: string | undefined) =>
  Number(minutes) * 60 + Number(secs) + (fraction ? Number(`0.${fraction}`) : 0);
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stamp = (time: number) => Math.max(0, time).toFixed(3);

interface Entry {
  begin: number;
  /** The text after the line's time tags, word tags included. */
  raw: string;
}

function lineBody(raw: string, begin: number, end: number, offset: number): string {
  const tags = Array.from(raw.matchAll(WORD_TAG));
  if (!tags.length) return escapeXml(raw.trim());
  let out = '';
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const from = (tag.index ?? 0) + tag[0].length;
    const to = i + 1 < tags.length ? tags[i + 1].index ?? raw.length : raw.length;
    const text = raw.slice(from, to);
    if (!text.trim()) continue;
    const wordBegin = seconds(tag[1], tag[2], tag[3]) - offset;
    const next = tags[i + 1];
    const wordEnd = next ? seconds(next[1], next[2], next[3]) - offset : end;
    const trailing = /\s$/.test(text) ? ' ' : '';
    out += `<span begin="${stamp(Math.max(begin, wordBegin))}" end="${stamp(Math.max(wordBegin, wordEnd))}">${escapeXml(text.trim())}</span>${trailing}`;
  }
  return out.trimEnd();
}

export function lrcToTtml(text: string): string {
  let offset = 0;
  const entries: Entry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const offsetTag = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (offsetTag) { offset = Number(offsetTag[1]) / 1000; continue; }
    const match = LINE.exec(line);
    if (!match) continue;
    for (const time of match[1].matchAll(STAMP)) entries.push({ begin: seconds(time[1], time[2], time[3]), raw: match[2] });
  }
  // A positive LRC offset means the lyrics should appear sooner.
  for (const entry of entries) entry.begin -= offset;
  entries.sort((a, b) => a.begin - b.begin);

  const lines: string[] = [];
  let wordTimed = false;
  entries.forEach((entry, i) => {
    if (!entry.raw.replace(WORD_TAG, '').trim()) return; // an empty line only marks where the one before it ends
    const end = i + 1 < entries.length ? entries[i + 1].begin : entry.begin + 5;
    const body = lineBody(entry.raw, entry.begin, end, offset);
    if (body.includes('<span')) wordTimed = true;
    lines.push(`<p begin="${stamp(entry.begin)}" end="${stamp(end)}" itunes:key="L${lines.length + 1}">${body}</p>`);
  });

  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="${wordTimed ? 'Word' : 'Line'}"><body><div>${lines.join('')}</div></body></tt>`;
}
