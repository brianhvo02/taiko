export const stringToColor = (str: string) => {
    const hash = str.split('').reduce((hash, char) => 
        char.charCodeAt(0) + ((hash << 5) - hash), 0);
    return '#' + [...Array(3).keys()]
        .map(i => ((hash >> (i * 8)) & 0xff).toString(16).padStart(2, '0'))
        .join('');
}

export const formalizeNumber = (n: number | string) => 
    (typeof n === 'number' ? n.toString() : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const getDuration = (seconds: number) => {
    const minutes = seconds / 60;
    const hours = minutes / 60;

    return hours < 1
        ? `${Math.floor(minutes)} min ${Math.floor(seconds % 60)} sec`
        : `${Math.floor(hours)} hr ${Math.floor(minutes % 60)} min`;
}

export const secondsToTime = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext("2d");

const fontSizes = [ 96, 72, 48, 32, 24 ]

export const getBestTextWidth = (text: string, maxWidth: number, fontSizeIdx = 0): number => {
    if (!ctx || fontSizeIdx > fontSizes.length - 1) return fontSizes[fontSizes.length - 1];
    
    const fontSize = fontSizes[fontSizeIdx];
    ctx.font = `bold ${fontSize}px CircularStd`;
    const { width } = ctx.measureText(text);
    
    return width < maxWidth ? fontSize : getBestTextWidth(text, maxWidth, fontSizeIdx + 1);
}