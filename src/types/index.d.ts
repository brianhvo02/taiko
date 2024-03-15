interface Query<Payload> {
    success: boolean;
    payload: Payload;
}

interface Message<Payload> {
    type: string;
    payload: Payload;
}

interface Track {
    track_id: string;
    title: string;
    track_number: number;
    disc_number: number;
    year: string;
    duration: number;
    cover_file: string;
    file_path: string;
    album_id: string;
    album: string;
    album_artist: string;
    artists: string;
    playlist_index?: number;
    playlist_id?: string;
    playlist_name?: string;
    playlist_owner?: string;
}

interface Album {
    id: string;
    name: string;
    artist: string;
    year: string;
    cover_file: string;
    tracks: Track[];
}

interface MetadataEventMap {
    progress: [string, number];
    operation: [Track];
    finished: [boolean];
    error: any;
}

interface User {
    id: string;
    display_name: string;
    username: string;
}

interface UserWithPassword extends User {
    password: string;
}

interface UserWithPasswordDigest extends User {
    password_digest: string;
}

type UserLogin = Pick<UserWithPassword, 'username' | 'password'>;

interface Playlist {
    id: string;
    name: string;
    owner: string;
    tracks: Track[];
}