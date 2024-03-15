import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import { defaultStringParam } from '../utils.js';
import { getCurrentUser } from './auth.js';

export const createPlaylist = async (req: Request, res: Response, next: NextFunction) => {
    const user = await getCurrentUser(req);
    if (!user)
        return res.status(401).json({ success: false });

    if (!req.body.name) 
        return res.status(422).json({ success: false });

    const payload = await db.createPlaylist(req.body.name, user.id);
    res.json({ success: true, payload });
}

export const getPlaylists = async (req: Request, res: Response, next: NextFunction) => {
    const withTracks = !!defaultStringParam(req.query.withTracks, '').length;
    const limit = parseInt(defaultStringParam(req.query.limit, '10'));
    const page = parseInt(defaultStringParam(req.query.p, '1'));

    if (!withTracks)
        return res.json({
            payload: await db.getPlaylists(limit, page),
            success: true
        });

    db.getPlaylistsWithTracks(limit, page)
        .then(payload => res.json({ payload, success: true }))
        .catch(() => res.status(500).json({ success: false }));
}

export const getPlaylist = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.params.playlistId)
        return res.status(422).json({ success: false });

    db.getPlaylist(req.params.playlistId)
        .then(payload => res.status(payload ? 200 : 404)
            .json({ payload, success: !!payload }))
        .catch(() => res.status(500).json({ success: false }));
}