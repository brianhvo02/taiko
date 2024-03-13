import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';

export const getAllTracks = async (req: Request, res: Response, next: NextFunction) => {
    const tracks = await db.all<Track>('SELECT title, track_number, cover_name, path, albums.name AS album, artists.name AS artist FROM tracks JOIN albums ON album_id = albums.id JOIN artists ON artist_id = artists.id');

    res.json(tracks);
}