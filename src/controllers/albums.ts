import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import { defaultStringParam } from '../utils.js';

export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
    const withTracks = !!defaultStringParam(req.query.withTracks, '').length;
    const limit = parseInt(defaultStringParam(req.query.limit, '10'));
    const page = parseInt(defaultStringParam(req.query.p, '1'));

    if (!withTracks)
        return res.json({
            payload: await db.getAlbums(limit, page),
            success: true
        });

    db.getAlbumsWithTracks(limit, page)
        .then(payload => res.json({ payload, success: true }))
        .catch(e => {
            console.error(e);
            res.status(500).json({ success: false })
        });
}

export const getAlbum = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.params.albumId)
        return res.status(422).json({ success: false });

    db.getAlbum(req.params.albumId)
        .then(payload => res.status(payload ? 200 : 404)
            .json({ payload, success: !!payload }))
        .catch(e => {
            console.error(e);
            res.status(500).json({ success: false })
        });
}