interface Track {
    id: string;
    title: string;
    track_number: number;
    cover_name: string;
    path: string;
    album: string;
    artist: string;
}

interface MetadataEventMap {
    progress: [string, number];
    operation: [Track];
    finished: [boolean];
    error: any;
}