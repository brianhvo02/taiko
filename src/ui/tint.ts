/**
 * A colour from a song's cover, to tint the full-screen lyrics: the picture's average colour, kept dark enough
 * and quiet enough for the drumhead-coloured lyrics to stay the brightest thing on the screen. Null when there is
 * no cover, or the picture can't be read (one served without permission for a page to look at it).
 */
const known = new Map<string, string | null>();

export async function coverTint(url: string): Promise<string | null> {
  const had = known.get(url);
  if (had !== undefined) return had;
  const tint = await new Promise<string | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 12;
        canvas.height = 12;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 12, 12);
        const pixels = context.getImageData(0, 0, 12, 12).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
        const count = pixels.length / 4;
        resolve(quieted(r / count / 255, g / count / 255, b / count / 255));
      } catch {
        resolve(null);
      }
    };
    image.src = url;
  });
  known.set(url, tint);
  return tint;
}

/** The colour's hue, at a set depth: never bright, never grey unless the picture is. */
function quieted(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const spread = max - min;
  let hue = 0;
  if (spread > 0) {
    if (max === r) hue = ((g - b) / spread) % 6;
    else if (max === g) hue = (b - r) / spread + 2;
    else hue = (r - g) / spread + 4;
  }
  const lightness = (max + min) / 2;
  const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(2 * lightness - 1));
  return `hsl(${Math.round(hue * 60 + 360) % 360} ${Math.round(Math.min(saturation, 0.55) * 100)}% 26%)`;
}
