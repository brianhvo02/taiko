import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import { broadcast, libraryUpdateServer } from '../ws.js';

let updatingFlag = false;

export const updateLibraryRequest = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.body.path)
        return res.status(422).json({ success: false });

    if (updatingFlag)
        return res.json({ success: false });
    else
        updatingFlag = true;

    db.saveMetadata(req.body.path)
        .on('progress', (file, progress) => {
            broadcast(libraryUpdateServer, 'progress', { file, progress });
        })
        .on('operation', track => {
            broadcast(libraryUpdateServer, 'operation', track);
        })
        .on('finished', () => {
            broadcast(libraryUpdateServer, 'finished');
            updatingFlag = false;
        })
        .on('error', err => {
            console.error(err);
        });

    res.status(201).json({ success: true });
}