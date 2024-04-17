import { PictureType } from 'jsmediatags/types';
import sqlite3 from 'sqlite3';
import { generateHash, getTags } from './utils.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, rm, symlink, writeFile } from 'fs/promises';
import { glob } from 'glob';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import EventEmitter from 'events';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { compare, hash } from 'bcrypt';
import _ from 'lodash';
import sharp, { ResizeOptions } from 'sharp';

const DATABASE_PATH = './metadata.db';
const SALT_ROUNDS = 10;

interface DbUserState {
    state_list_id?: string;
    state_idx?: number;
    state_shuffle_active?: number;
    state_shuffle_map?: string;
    state_elapsed?: number;
    state_duration?: number;
    state_repeat?: string;
    state_volume?: number;
}

export default class MetadataDatabase {
    db: sqlite3.Database;

    private constructor(dbPath: string) {
        this.db = new sqlite3.Database(dbPath);
    }

    static async init(dbPath: string) {
        const db = new this(dbPath);

        const tables = await Promise.all([
            'tracks',
            'albums',
            'artists',
            'track_artists',
        ].map(tableName => db.get<Boolean>('SELECT name FROM sqlite_master WHERE type="table" AND name=(?)', tableName)));

        if (tables.every(table => table)) 
            return db;

        await mkdir('./images', { recursive: true });
        
        await db.exec(
            `CREATE TABLE artists (
                id TEXT PRIMARY KEY, 
                name TEXT UNIQUE
            )`
        );

        await db.exec(
            `CREATE TABLE albums (
                id TEXT PRIMARY KEY, 
                name TEXT NOT NULL, 
                artist_id TEXT, 
                FOREIGN KEY(artist_id) REFERENCES artists(id)
            )`
        );
        await db.exec('CREATE UNIQUE INDEX album_idx ON albums (name, artist_id)');

        await db.exec(
            `CREATE TABLE tracks (
                id TEXT PRIMARY KEY, 
                title TEXT NOT NULL, 
                track_number INTEGER NOT NULL, 
                disc_number INTEGER NOT NULL,
                year TEXT,
                duration INTEGER,
                cover_file TEXT, 
                file_path TEXT UNIQUE, 
                album_id TEXT, 
                FOREIGN KEY(album_id) REFERENCES albums(id)
            )`
        );
        await db.exec('CREATE UNIQUE INDEX track_idx ON tracks (album_id, disc_number, track_number)');

        await db.exec(
            `CREATE TABLE track_artists (
                track_id TEXT, 
                artist_id TEXT, 
                FOREIGN KEY(track_id) REFERENCES tracks(id), 
                FOREIGN KEY(artist_id) REFERENCES artists(id)
            )`
        );
        await db.exec('CREATE UNIQUE INDEX track_artists_idx ON track_artists (track_id, artist_id)');

        await db.exec(
            `CREATE TABLE users (
                id TEXT PRIMARY KEY, 
                display_name TEXT NOT NULL, 
                username TEXT UNIQUE,
                password_digest TEXT NOT NULL,
                state_list_id TEXT,
                state_idx INTEGER,
                state_shuffle_active INTEGER,
                state_shuffle_map TEXT,
                state_elapsed REAL,
                state_duration REAL,
                state_repeat TEXT,
                state_volume INTEGER
            )`
        );

        await db.exec(
            `CREATE TABLE playlists (
                id TEXT PRIMARY KEY, 
                name TEXT NOT NULL, 
                track_order TEXT,
                owner_id TEXT, 
                FOREIGN KEY(owner_id) REFERENCES users(id)
            )`
        );

        await db.exec(
            `CREATE TABLE playlist_tracks (
                playlist_id TEXT, 
                track_id TEXT, 
                FOREIGN KEY(playlist_id) REFERENCES playlists(id),
                FOREIGN KEY(track_id) REFERENCES tracks(id)
            )`
        );
        await db.exec('CREATE UNIQUE INDEX playlist_track_idx ON playlist_tracks (playlist_id, track_id)');

        return db;
    }

    async cleanup() {
        await new Promise<void>((resolve, reject) => this.db.close(err => err ? reject(err) : resolve()));
    }

    private exec = async (sql: string) => new Promise<void>(
        (resolve, reject) => this.db.exec(sql, err => err ? reject(err) : resolve())
    );

    private run = async (sql: string, ...params: (string | number)[]) => new Promise<void>(
        (resolve, reject) => this.db.run(sql, params, err => err ? reject(err) : resolve())
    );

    private get = async <T>(sql: string, ...params: (string | number)[]) => new Promise<T | undefined>(
        (resolve, reject) => this.db.get<T>(sql, params, (err, row) => err ? reject(err) : resolve(row))
    );

    private all = async <T>(sql: string, ...params: (string | number)[]) => new Promise<T[]>(
        (resolve, reject) => this.db.all<T>(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

    getTrackPath = async (trackId: string) => this.get<Track>('SELECT file_path FROM tracks WHERE id = (?)', trackId);

    async saveCover(picture?: PictureType) {
        if (!picture)
            return '';
    
        const buf = Buffer.from(new Uint8Array(picture.data));
        const hash = generateHash(buf);
        const filename = `${hash}.${picture.format === 'image/png' ? 'png' : 'jpg'}`;
        const imagePath = join('images', filename);
        if (!existsSync(imagePath))
            await writeFile(imagePath, buf);
    
        return filename;
    }

    saveMetadata(path: string) {
        const emitter = new EventEmitter<MetadataEventMap>();
        
        glob('**/*.{m4a,mp3}', { cwd: path }).then(async files => {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                emitter.emit('progress', file, (i + 1) / files.length * 100);
                const { tags: { 
                    title, artist: artistRaw, album, track, picture, year, disk, aART, TPE2,
                } } = await getTags(join(path, file));
        
                if (!title || !artistRaw || !album || !track || !year || (!aART && !TPE2))
                    continue;

                const albumArtist: string = (aART ?? TPE2).data;
                const albumArtistRow = await this.get<{ id: string }>('SELECT id FROM artists WHERE name = (?)', albumArtist);
                const albumArtistId = albumArtistRow ? albumArtistRow.id : randomUUID();
                if (!albumArtistRow)
                    await this.run('INSERT INTO artists (id, name) VALUES (?, ?)', albumArtistId, albumArtist);

                const albumRow = await this.get<{ id: string }>('SELECT id FROM albums WHERE name = (?) AND artist_id = (?)', album, albumArtistId);
                const albumId = albumRow ? albumRow.id : randomUUID();
                if (!albumRow)
                    await this.run('INSERT INTO albums (id, name, artist_id) VALUES (?, ?, ?)', albumId, album, albumArtistId);

                const trackRow = await this.get<{ id: string }>('SELECT id FROM tracks WHERE title = (?) AND album_id = (?)', title, albumId);
                if (trackRow)
                    continue;
                const trackId = randomUUID();

                const artists = artistRaw.split(';');
    
                for (const artist of artists) {
                    const artistRow = await this.get<{ id: string }>('SELECT id FROM artists WHERE name = (?)', artist);
                    const artistId = artistRow ? artistRow.id : randomUUID();
                    if (!artistRow)
                        await this.run('INSERT INTO artists (id, name) VALUES (?, ?)', artistId, artist);
                    await this.run('INSERT INTO track_artists (track_id, artist_id) VALUES (?, ?)', trackId, artistId);
                }
                
                const duration = await getAudioDurationInSeconds(join(path, file));
                const cover = await this.saveCover(picture);
                await this.run(
                    `INSERT INTO tracks (
                        id, title, track_number, year, duration, cover_file, file_path, album_id, disc_number
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                    trackId, title, track, year, duration, cover, file, albumId, disk?.data.disk ?? 1
                );
                emitter.emit('operation', { 
                    title, album, year, duration,
                    artists: artistRaw,
                    track_id: trackId, 
                    album_id: albumId,
                    album_artist: albumArtist,
                    cover_file: cover, 
                    track_number: parseInt(track), 
                    disc_number: parseInt(disk?.data.disk ?? '1'),
                    file_path: file, 
                });
            }

            emitter.emit('finished', true);
        }).catch(err => emitter.emit('error', err));

        return emitter;
    }

    getAlbums = async (limit: number, page: number) => this.all<Omit<Album, 'tracks'>>(
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

    async getAlbumsWithTracks(limit: number, page: number) {
        const rawAlbums = await this.all<Track>(
            `SELECT 
                album_artist, album, track_number, disc_number, title, year, duration, cover_file, file_path,
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
            ORDER BY album_artist, album, disc_number, track_number`,
            limit, (page - 1) * limit
        );

        if (!rawAlbums)
            throw new Error();

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

        return Object.values(albumsMap);
    }

    async getAlbum(albumId: string) {
        const tracks = await this.all<Track>(
            `SELECT 
                track_number, disc_number, title, year, duration, cover_file, file_path, tracks.album_id,
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
            ORDER BY disc_number, track_number`,
            albumId
        );

        if (!tracks)
            throw new Error();

        return tracks[0] ? {
            id: tracks[0].album_id,
            name: tracks[0].album,
            artist: tracks[0].album_artist,
            year: tracks[0].year,
            cover_file: tracks[0].cover_file,
            tracks
        } : null;
    }

    async createPlaylist(name: string, owner_id: string) {
        const id = randomUUID();
        await this.run(
            `INSERT INTO playlists (
                id, name, track_order, owner_id
            ) VALUES (?, ?, ?, ?)`,
            id, name, '', owner_id
        );

        await symlink('../frontend/public/taiko.png', join('images', id + '.png'));

        return id;
    }

    getPlaylists = async (limit: number, page: number) => this.all<Omit<Playlist, 'tracks'>>(
        `SELECT
            playlists.id as id, playlists.name AS name, users.display_name AS owner
        FROM playlists
        JOIN users ON playlists.owner_id = users.id
        ORDER BY owner, name
        LIMIT (?)
        OFFSET (?)`,
        limit, (page - 1) * limit
    );

    // async getPlaylistsWithTracks(limit: number, page: number) {
    //     const rawAlbums = await this.all<Track>(
    //         `SELECT 
    //             album_artist, album, track_number, disc_number, title, year, duration, cover_file, file_path,
    //             tracks.id AS track_id, album_id,
    //             GROUP_CONCAT(artists.name, ";") AS artists
    //         FROM (
    //             SELECT
    //                 albums.id, albums.name AS album, artists.name AS album_artist
    //             FROM albums
    //             JOIN artists
    //                 ON albums.artist_id = artists.id
    //             ORDER BY album_artist, album
    //             LIMIT (?)
    //             OFFSET (?)
    //         ) AS albums
    //         JOIN tracks 
    //             ON album_id = albums.id 
    //         JOIN track_artists
    //             ON track_artists.track_id = tracks.id
    //         JOIN artists
    //             ON track_artists.artist_id = artists.id
    //         GROUP BY tracks.id
    //         ORDER BY album_artist, album, disc_number, track_number`,
    //         limit, (page - 1) * limit
    //     );

    //     if (!rawAlbums)
    //         throw new Error();

    //     const albumsMap = rawAlbums.reduce((map: Record<string, Album>, track) => {
    //         (map[track.album_id] ??= {
    //             id: track.album_id,
    //             name: track.album,
    //             artist: track.album_artist,
    //             year: track.year,
    //             cover_file: track.cover_file,
    //             tracks: [] as Track[]
    //         }).tracks.push(track);
    //         return map;
    //     }, {});

    //     return Object.values(albumsMap);
    // }

    async getPlaylist(playlistId: string): Promise<Playlist | null> {
        const tracks = await this.all<Required<Track>>(
            `SELECT 
                track_number, disc_number, title, year, duration, cover_file, file_path, tracks.album_id, 
                playlists.id AS playlist_id,
                playlists.name AS playlist_name,
                users.display_name AS playlist_owner,
                tracks.id AS track_id,
                album_artists.name AS album_artist,
                albums.name AS album, 
                GROUP_CONCAT(artists.name, ";") AS artists
            FROM playlists
            JOIN playlist_tracks 
                ON playlists.id = playlist_tracks.playlist_id
            JOIN tracks 
                ON tracks.id = playlist_tracks.track_id
            JOIN users
                ON users.id = playlists.owner_id
            JOIN artists AS album_artists
                ON albums.artist_id = album_artists.id
            JOIN albums 
                ON tracks.album_id = albums.id 
            JOIN track_artists
                ON track_artists.track_id = tracks.id
            JOIN artists
                ON track_artists.artist_id = artists.id
            WHERE playlists.id = (?)
            GROUP BY tracks.id`,
            playlistId
        );

        if (!tracks)
            throw new Error();

        if (!tracks.length) {
            const playlist = await this.get<Omit<Playlist, 'tracks'>>(
                `SELECT
                    playlists.id as id, playlists.name AS name, users.display_name AS owner
                FROM playlists
                JOIN users ON playlists.owner_id = users.id
                WHERE playlists.id = (?)`,
                playlistId
            );

            if (!playlist)
                return null;

            return {
                ...playlist,
                tracks: [] as Track[]
            };
        }

        const requested = await this.get<{ track_order: string }>(
            `SELECT track_order
            FROM playlists
            WHERE id = (?)`,
            playlistId
        );

        if (!requested)
            return null;

        const trackMap = tracks.reduce((obj: Record<string, Track>, track) => {
            obj[track.track_id] = track;
            return obj;
        }, {});

        return {
            id: tracks[0].playlist_id,
            name: tracks[0].playlist_name,
            owner: tracks[0].playlist_owner,
            tracks: [...requested.track_order
                .matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)]
                .map(([trackId]) => trackMap[trackId])
        };
    }

    private async generatePlaylistCover(trackOrder: string, playlistId: string) {
        const playlistCoverPath = join('images', playlistId + '.png');
        const matches = [...trackOrder.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)];
        const ids = matches.map(([id]) => `"${id}"`);

        if (!ids.length) {
            await rm(playlistCoverPath);
            await symlink('../frontend/public/taiko.png', playlistCoverPath);
            return;
        }

        const covers = await this.all<Pick<Track, 'cover_file'>>(
            `SELECT cover_file
            FROM tracks
            WHERE id IN (${ids.join(', ')})
            ORDER BY
                CASE id
                ${ids.map((id, i) => `WHEN ${id} THEN ${i + 1}`).join('\n')}
                END`
        );

        if (!covers.length) {
            await rm(playlistCoverPath);
            await symlink('../frontend/public/taiko.png', playlistCoverPath);
            return;
        } else if (covers.length < 4) {
            await rm(playlistCoverPath);
            await symlink(covers[0].cover_file, playlistCoverPath);
            return;
        }

        const coverBuffers = await Promise.all(
            [...new Set(covers.map(({ cover_file }) => cover_file))].slice(0, 4)
                .map(async cover => readFile(join('images', cover)))
        );

        const resizeOptions: ResizeOptions = { width: 500, height: 500, fit: 'cover' };

        await rm(playlistCoverPath);
        await sharp(
            Buffer.alloc(1000 * 1000 * 4), 
            { raw: { width: 1000, height: 1000, channels: 4 } }
        ).composite([
            { input: await sharp(coverBuffers[0]).resize(resizeOptions).toBuffer(), top: 0, left: 0 },
            { input: await sharp(coverBuffers[1]).resize(resizeOptions).toBuffer(), top: 0, left: 500 },
            { input: await sharp(coverBuffers[2]).resize(resizeOptions).toBuffer(), top: 500, left: 0 },
            { input: await sharp(coverBuffers[3]).resize(resizeOptions).toBuffer(), top: 500, left: 500 },
        ]).png().toFile(playlistCoverPath);
    }

    async addTrackToPlaylist(userId: string, playlistId: string, trackId: string) {
        const order = await this.get<{ track_order: string }>(
            `SELECT track_order
            FROM playlists
            WHERE id = (?) AND owner_id = (?)`,
            playlistId, userId
        );

        if (!order) return false;

        const track = await this.get<{ id: string }>(
            `SELECT id
            FROM tracks
            WHERE id = (?)`,
            trackId
        );

        if (!track) throw new Error(`${trackId} not a valid track`);

        await this.run(
            `INSERT INTO playlist_tracks (
                playlist_id, track_id
            ) VALUES (?, ?)`,
            playlistId, trackId
        );

        await this.run(
            `UPDATE playlists
            SET track_order = track_order || (?)
            WHERE id = (?)`,
            trackId, playlistId
        );

        await this.generatePlaylistCover(order.track_order + trackId, playlistId);

        return true;
    }

    async removeTrackFromPlaylist(userId: string, playlistId: string, trackId: string) {
        const order = await this.get<{ track_order: string }>(
            `SELECT track_order
            FROM playlists
            WHERE id = (?) AND owner_id = (?)`,
            playlistId, userId
        );

        if (!order) return false;

        await this.run(
            `DELETE FROM playlist_tracks 
            WHERE playlist_id = (?) AND track_id = (?)`,
            playlistId, trackId
        );

        await this.run(
            `UPDATE playlists
            SET track_order = REPLACE(track_order, (?), "")
            WHERE id = (?)`,
            trackId, playlistId
        );

        await this.generatePlaylistCover(order.track_order.replaceAll(trackId, ''), playlistId);

        return true;
    }

    async changeTrackOrder(userId: string, playlistId: string, trackOrder: string) {
        const order = await this.get<{ track_order: string }>(
            `SELECT track_order
            FROM playlists
            WHERE id = (?) AND owner_id = (?)`,
            playlistId, userId
        );

        if (!order) return false;

        if (order.track_order === trackOrder)
            return true;
        
        await this.run(
            `UPDATE playlists
            SET track_order = (?)
            WHERE id = (?)`,
            trackOrder, playlistId
        );

        await this.generatePlaylistCover(trackOrder, playlistId);

        return true;
    }

    async createUser(user: Omit<UserWithPassword, 'id'>): Promise<User | null> {
        const { display_name, username, password } = user;

        const id = randomUUID();
        const password_digest = await hash(password, SALT_ROUNDS);

        try {
            await this.run(
                `INSERT INTO users (
                    id, display_name, username, password_digest
                ) VALUES (?, ?, ?, ?)`,
                id, display_name, username, password_digest
            );
            return { id, display_name, username };
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    async getUserByCredentials(login: UserLogin): Promise<User | null> {
        const requested = await this.get<Pick<UserWithPasswordDigest, 'password_digest'>>(
            `SELECT password_digest
            FROM users
            WHERE username = (?)`,
            login.username
        );

        if (!requested) return null;

        if (!await compare(login.password, requested.password_digest)) 
            return null;

        const user = await this.get<User>(
            `SELECT id, display_name, username
            FROM users
            WHERE username = (?)`,
            login.username
        );

        return user ?? null;
    }

    async getUserById(userId: string) {
        const user = await this.get<User>(
            `SELECT id, display_name, username
            FROM users
            WHERE id = (?)`,
            userId
        );

        return user;
    }

    async getUserState(userId: string) {
        const state = await this.get<DbUserState>(
            `SELECT state_list_id, state_idx, state_shuffle_active, state_shuffle_map, 
                state_elapsed, state_duration, state_repeat, state_volume
            FROM users
            WHERE id = (?)`,
            userId
        );

        const audioState: AudioState = {
            currentAudio: {
                idx: -1,
                listId: '',
                tracks: [],
            },
            shuffleState: {
                active: false,
                map: [],
            },
            elapsed: 0,
            duration: 0,
            isPlaying: false,
            repeat: 'off',
            volume: 100,
            volumeMemory: null,
        };

        if (!state)
            return audioState;

        if (state.state_list_id && state.state_idx !== undefined) {
            const album = await this.getAlbum(state.state_list_id);
            const playlist = await this.getPlaylist(state.state_list_id);
            if (album || playlist) {
                audioState.currentAudio.tracks = album?.tracks ?? playlist?.tracks ?? []; 
                audioState.currentAudio.listId = state.state_list_id;
                audioState.currentAudio.idx = state.state_idx;
            }
        }

        if (state.state_shuffle_active !== undefined && state.state_shuffle_map) {
            audioState.shuffleState.active = Boolean(state.state_shuffle_active);
            audioState.shuffleState.map = state.state_shuffle_map.split(',').map(i => parseInt(i));
        }

        if (state.state_elapsed)
            audioState.elapsed = state.state_elapsed;

        if (state.state_duration)
            audioState.duration = state.state_duration;

        if (state.state_repeat)
            audioState.repeat = state.state_repeat as RepeatMode;

        if (state.state_volume)
            audioState.volume = state.state_volume;

        return audioState;
    }

    async updateUserState(userId: string, state: Partial<AudioState>) {
        if (!Object.keys(state).length) return;

        const newUserState: DbUserState = {};

        if (state.currentAudio) {
            newUserState.state_list_id = state.currentAudio.listId;
            newUserState.state_idx = state.currentAudio.idx;
        }

        if (state.shuffleState) {
            newUserState.state_shuffle_active = Number(state.shuffleState.active);
            newUserState.state_shuffle_map = state.shuffleState.map.join();
        }

        if (state.elapsed !== undefined)
            newUserState.state_elapsed = state.elapsed;

        if (state.duration)
            newUserState.state_duration = state.duration;

        if (state.repeat)
            newUserState.state_repeat = state.repeat;

        if (state.volume !== undefined)
            newUserState.state_volume = state.volume;

        await this.run(
            `UPDATE users
            SET ${Object.keys(newUserState).map(key => `${key} = (?)`).join(', ')}
            WHERE id = (?)`,
            ...Object.values(newUserState),
            userId
        );
    }
}

export const db = await MetadataDatabase.init(DATABASE_PATH);