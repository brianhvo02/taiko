import { createHash } from 'crypto';
import { read } from 'jsmediatags';
import type { TagType } from 'jsmediatags/types';

export const getTags = (path: string) => new Promise<TagType>((resolve, reject) => read(path, { onSuccess: resolve, onError: reject }));

export const generateHash = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');