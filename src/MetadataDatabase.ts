import { PictureType } from 'jsmediatags/types';
import sqlite3 from 'sqlite3';
import { generateHash, getTags } from './utils.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { glob } from 'glob';
import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import EventEmitter from 'events';
import { getAudioDurationInSeconds } from 'get-audio-duration';

const DATABASE_PATH = './metadata.db';

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

        return db;
    }

    async cleanup() {
        await new Promise<void>((resolve, reject) => this.db.close(err => err ? reject(err) : resolve()));
    }

    exec = async (sql: string) => new Promise<void>(
        (resolve, reject) => this.db.exec(sql, err => err ? reject(err) : resolve())
    );

    run = async (sql: string, ...params: (string | number)[]) => new Promise<void>(
        (resolve, reject) => this.db.run(sql, params, err => err ? reject(err) : resolve())
    );

    get = async <T>(sql: string, ...params: (string | number)[]) => new Promise<T | undefined>(
        (resolve, reject) => this.db.get<T>(sql, params, (err, row) => err ? reject(err) : resolve(row))
    );

    all = async <T>(sql: string, ...params: (string | number)[]) => new Promise<T[] | undefined>(
        (resolve, reject) => this.db.all<T>(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

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
}

// await MetadataDatabase.resetEnvironment();
export const db = await MetadataDatabase.init(DATABASE_PATH);