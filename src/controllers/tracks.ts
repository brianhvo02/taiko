import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import { join } from 'path';
import { libraryDir } from '../env.js';

export const getTrackAudio = async (req: Request, res: Response, next: NextFunction) => {
    const track = await db.getTrackPath(req.params.trackId);

    if (!track)
        return res.status(422).end();

    res.setHeader('Content-Type', 'audio/mp4')
        .sendFile(join('./library', track.file_path), { root: libraryDir });
}