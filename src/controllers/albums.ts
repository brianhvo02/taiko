import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import { defaultStringParam } from '../utils.js';

export const getAlbums = async (req: Request, res: Response, next: NextFunction) => {
    const withTracks = !!defaultStringParam(req.query.withTracks, '').length;
    const page = parseInt(defaultStringParam(req.query.p, '1'));
    const limit = parseInt(defaultStringParam(req.query.limit, '10'));

    if (!withTracks) {
        const payload = await db.all<Omit<Album, 'tracks'>>(
            `SELECT
                albums.id as id, albums.name AS name, artists.name AS artist, cover_file, year
            FROM albums
            JOIN artists
                ON albums.artist_id = artists.id
            LEFT JOIN tracks
                ON albums.id = tracks.album_id
            GROUP BY albums.id
            HAVING MIN(track_number)
            ORDER BY artist, name
            LIMIT (?)
            OFFSET (?)`,
            limit, (page - 1) * limit
        );

        return res.json({
            payload,
            success: true
        });
    }

    const rawAlbums = await db.all<Track>(
        `SELECT 
            album_artist, album, track_number, title, year, duration, cover_file, file_path,
            tracks.id AS track_id, album_id,
            GROUP_CONCAT(artists.name, ";") AS artists
        FROM (
            SELECT
                albums.id, albums.name AS album, artists.name AS album_artist
            FROM albums
            JOIN artists
                ON albums.artist_id = artists.id
            ORDER BY album_artist, album
            LIMIT (?)
            OFFSET (?)
        ) AS albums
        JOIN tracks 
            ON album_id = albums.id 
        JOIN track_artists
            ON track_artists.track_id = tracks.id
        JOIN artists
            ON track_artists.artist_id = artists.id
        GROUP BY tracks.id
        ORDER BY album_artist, album, track_number`,
        limit, (page - 1) * limit
    );

    if (!rawAlbums || !rawAlbums.length)
        return res.status(500).json({ success: false });

    const albumsMap = rawAlbums.reduce((map: Record<string, Album>, track) => {
        (map[track.album_id] ??= {
            id: track.album_id,
            name: track.album,
            artist: track.album_artist,
            year: track.year,
            cover_file: track.cover_file,
            tracks: [] as Track[]
        }).tracks.push(track);
        return map;
    }, {});

    res.json({
        payload: Object.values(albumsMap),
        success: true,
    });
}

export const getAlbum = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.params.albumId)
        return res.status(422).json({ success: false });

    const tracks = await db.all<Track>(
        `SELECT 
            track_number, title, year, duration, cover_file, file_path, tracks.album_id,
            tracks.id AS track_id,
            album_artists.name AS album_artist,
            albums.name AS album, 
            GROUP_CONCAT(artists.name, ";") AS artists
        FROM tracks
        JOIN artists AS album_artists
            ON albums.artist_id = album_artists.id
        JOIN albums 
            ON tracks.album_id = albums.id 
        JOIN track_artists
            ON track_artists.track_id = tracks.id
        JOIN artists
            ON track_artists.artist_id = artists.id
        WHERE albums.id = (?)
        GROUP BY tracks.id
        ORDER BY track_number`,
        req.params.albumId
    );

    if (!tracks || !tracks.length)
        return res.status(404).json({ success: false });

    res.json({
        success: true,
        payload: {
            id: tracks[0].album_id,
            name: tracks[0].album,
            artist: tracks[0].album_artist,
            year: tracks[0].year,
            cover_file: tracks[0].cover_file,
            tracks
        }
    });
}