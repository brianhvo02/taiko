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

const DATABASE_PATH = '';

export default class MetadataDatabase {
    db: sqlite3.Database;

    static async resetEnvironment() {
        await rm('./metadata.db');
        await rm('./images', { recursive: true, force: true });
        await mkdir('./images')
    }

    private constructor(dbPath: string) {
        this.db = new sqlite3.Database(dbPath);
    }

    static async init(dbPath: string) {
        const db = new this(dbPath);

        const tables = await Promise.all([
            'tracks',
            'albums',
            'artists',
        ].map(tableName => db.get<Boolean>('SELECT name FROM sqlite_master WHERE type="table" AND name=(?)', tableName)));

        if (tables.every(table => table)) 
            return db;
        
        await db.exec('CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT UNIQUE)');
        await db.exec('CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, artist_id TEXT, FOREIGN KEY(artist_id) REFERENCES artists(id))');
        await db.exec('CREATE UNIQUE INDEX album_idx ON albums (name, artist_id)');
        await db.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, track_number INTEGER NOT NULL, cover_name TEXT, path TEXT UNIQUE, album_id TEXT, FOREIGN KEY(album_id) REFERENCES albums(id))');
        await db.exec('CREATE UNIQUE INDEX track_idx ON tracks (album_id, track_number)');

        return db;
    }

    async cleanup() {
        await new Promise<void>((resolve, reject) => this.db.close(err => err ? reject(err) : resolve()));
    }

    exec = async (sql: string) => new Promise<void>(
        (resolve, reject) => this.db.exec(sql, err => err ? reject(err) : resolve())
    );

    run = async (sql: string, ...params: string[]) => new Promise<void>(
        (resolve, reject) => this.db.run(sql, params, err => err ? reject(err) : resolve())
    );

    get = async <T>(sql: string, ...params: string[]) => new Promise<T | undefined>(
        (resolve, reject) => this.db.get<T>(sql, params, (err, row) => err ? reject(err) : resolve(row))
    );

    all = async <T>(sql: string, ...params: string[]) => new Promise<T[] | undefined>(
        (resolve, reject) => this.db.all<T>(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

    // exec = async (sql: string) => new Promise<void>(
    //     (resolve, reject) => this.db.exec(sql, err => err ? reject(err) : resolve())
    // );

    async saveCover(picture?: PictureType) {
        if (!picture)
            return '';
    
        const buf = Buffer.from(new Uint8Array(picture.data));
        const hash = generateHash(buf);
        const filename = `${hash}.${picture.format === 'image/png' ? '.png' : '.jpg'}`;
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
                    title, artist, album, track, picture,
                } } = await getTags(join(path, file));
        
                if (!title || !artist || !album || !track)
                    continue;
    
                const artistRow = await this.get<{ id: string }>('SELECT id FROM artists WHERE name = (?)', artist);
                const artistId = artistRow ? artistRow.id : randomUUID();
                if (!artistRow)
                    await this.run('INSERT INTO artists (id, name) VALUES (?, ?)', artistId, artist);

                const albumRow = await this.get<{ id: string }>('SELECT id FROM albums WHERE name = (?) AND artist_id = (?)', album, artistId);
                const albumId = albumRow ? albumRow.id : randomUUID();
                if (!albumRow)
                    await this.run('INSERT INTO albums (id, name, artist_id) VALUES (?, ?, ?)', albumId, album, artistId);

                const trackRow = await this.get<{ id: string }>('SELECT id FROM tracks WHERE title = (?) AND album_id = (?)', title, albumId);
                if (trackRow)
                    continue;
                const trackId = randomUUID();
                
                const cover = await this.saveCover(picture);
                await this.run('INSERT INTO tracks (id, title, track_number, cover_name, path, album_id) VALUES (?, ?, ?, ?, ?, ?)', trackId, title, track, cover, file, albumId);
                emitter.emit('operation', { 
                    title, artist, album, 
                    id: trackId, 
                    cover_name: cover, 
                    track_number: parseInt(track), 
                    path: file, 
                });
            }

            emitter.emit('finished', true);
        }).catch(err => emitter.emit('error', err));

        return emitter;
    }
}

// await MetadataDatabase.resetEnvironment();
export const db = await MetadataDatabase.init('./metadata.db');