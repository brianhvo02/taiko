interface Track {
    track_id: string;
    title: string;
    track_number: number;
    cover_file: string;
    file_path: string;
    album_id: string;
    album: string;
    album_artist: string;
    artists: string;
}

interface Album {
    id: string;
    name: string;
    artist: string;
    tracks: Track[];
}

interface MetadataEventMap {
    progress: [string, number];
    operation: [Track];
    finished: [boolean];
    error: any;
}