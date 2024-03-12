import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';
import { AlbumWithArtist, TrackPayload } from '../../../src/types';

export interface CurrentAudio {
    idx: number,
    trackList: TrackPayload[];
    track: TrackPayload;
    album: AlbumWithArtist;
}

const REPEAT_MODES = ['off', 'all', 'one'] as const;
export type RepeatMode = typeof REPEAT_MODES[number];

interface AudioState {
    currentAudio: CurrentAudio | null;
    elapsed: number;
    isPlaying: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    volume: number;
}

const initialState: AudioState = {
    currentAudio: null,
    elapsed: 0,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    volume: 100,
}

export const audioSlice = createSlice({
    name: 'audio',
    initialState,
    reducers: {
        setCurrentAudio: (state, { payload }: PayloadAction<CurrentAudio>) => {
            state.currentAudio = payload;
        },
        setElapsed: (state, { payload }: PayloadAction<number>) => {
            state.elapsed = payload;
        },
        toggleIsPlaying: state => {
            state.isPlaying = !state.isPlaying;
        },
        setIsPlaying: (state, { payload }: PayloadAction<boolean>) => {
            state.isPlaying = payload;
        },
        toggleShuffle: state => {
            state.shuffle = !state.shuffle;
        },
        toggleRepeat: state => {
            state.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % 3];
        },
        forwardOne: (state, { payload }: PayloadAction<boolean>) => {
            if (!state.currentAudio || (state.repeat === 'one' && !payload))
                return;

            const { trackList, idx } = state.currentAudio;
            if (state.repeat === 'off' && idx === trackList.length - 1)
                return;

            state.currentAudio.idx = (idx + 1) % trackList.length;
            state.currentAudio.track = trackList[state.currentAudio.idx];

            if (state.repeat === 'one')
                state.repeat = 'all';
        },
        previousOne: state => {
            if (!state.currentAudio)
                return;

            const { trackList, idx } = state.currentAudio;
            if (state.repeat === 'off' && idx === 0)
                return;

            state.currentAudio.idx = idx - 1 < 0 ? trackList.length - 1 : idx - 1;
            state.currentAudio.track = trackList[state.currentAudio.idx];

            if (state.repeat === 'one')
                state.repeat = 'all';
        },
        setVolume: (state, { payload }: PayloadAction<number>) => {
            state.volume = payload;
        }
    },
})

export const { 
    setCurrentAudio, setElapsed, setIsPlaying,
    toggleIsPlaying, toggleShuffle, toggleRepeat,
    forwardOne, previousOne, setVolume
} = audioSlice.actions;

export const useAudio = () => useAppSelector(state => state.audio);

export default audioSlice;