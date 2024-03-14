import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';
import { MutableRefObject } from 'react';

export interface CurrentAudio {
    idx: number,
    trackList: Track[];
    track: Track;
}

const REPEAT_MODES = ['off', 'all', 'one'] as const;
export type RepeatMode = typeof REPEAT_MODES[number];

interface AudioState {
    currentAudio: CurrentAudio | null;
    elapsed: number;
    duration: number;
    isPlaying: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    volume: number;
    volumeMemory: number | null;
}

const initialState: AudioState = {
    currentAudio: null,
    elapsed: 0,
    duration: 0,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    volume: 100,
    volumeMemory: null,
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
        setDuration: (state, { payload }: PayloadAction<number>) => {
            state.duration = payload;
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
            if (payload > 0 && state.volumeMemory !== null)
                state.volumeMemory = null;
        },
        toggleMute: (state, { payload }: PayloadAction<MutableRefObject<HTMLAudioElement>>) => {
            if (state.volume > 0 && state.volumeMemory === null) {
                state.volumeMemory = state.volume;
                payload.current.volume = 0;
            } else {
                payload.current.volume = (state.volumeMemory ?? 0) / 100;
                state.volumeMemory = null;
            }
        }
    },
})

export const { 
    setCurrentAudio, setElapsed, setDuration, setIsPlaying,
    toggleIsPlaying, toggleShuffle, toggleRepeat,
    forwardOne, previousOne, setVolume, toggleMute
} = audioSlice.actions;

export const useAudio = () => useAppSelector(state => state.audio);

export default audioSlice;