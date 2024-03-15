import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';
import { MutableRefObject, useMemo } from 'react';
import _ from 'lodash';

interface CurrentAudio {
    idx: number,
    listId: string;
    tracks: Track[];
}

interface ShuffleState {
    active: boolean;
    map: number[];
}

const REPEAT_MODES = ['off', 'all', 'one'] as const;
export type RepeatMode = typeof REPEAT_MODES[number];

interface AudioState {
    currentAudio: CurrentAudio;
    shuffleState: ShuffleState;
    elapsed: number;
    duration: number;
    isPlaying: boolean;
    repeat: RepeatMode;
    volume: number;
    volumeMemory: number | null;
}

const initialState: AudioState = {
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
}

export const audioSlice = createSlice({
    name: 'audio',
    initialState,
    reducers: {
        setCurrentAudio: (state, { payload }: PayloadAction<CurrentAudio>) => {
            if (state.shuffleState.active) {
                const { idx, tracks, listId } = payload;
                const indices = [...Array(tracks.length).keys()];
                state.shuffleState.map = _.shuffle(indices.slice(0, idx).concat(indices.slice(idx + 1, tracks.length)));
                state.shuffleState.map.unshift(idx);
                state.currentAudio = {
                    listId, tracks,
                    idx: 0,
                }

                return;
            }

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
            state.shuffleState.active = !state.shuffleState.active;
            if (!state.currentAudio) return;

            if (state.shuffleState.active) {
                const { idx, tracks } = state.currentAudio;
                const indices = [...Array(tracks.length).keys()];
                state.shuffleState.map = _.shuffle(indices.slice(0, idx).concat(indices.slice(idx + 1, tracks.length)));
                state.shuffleState.map.unshift(idx);
                state.currentAudio.idx = 0;
            } else {
                state.currentAudio.idx = state.shuffleState.map[state.currentAudio.idx];
                state.shuffleState.map = [];
            }
        },
        toggleRepeat: state => {
            state.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % 3];
        },
        forwardOne: (state, { payload }: PayloadAction<boolean>) => {
            if (!state.currentAudio || (state.repeat === 'one' && !payload))
                return;

            const { tracks, idx } = state.currentAudio;
            if (state.repeat === 'off' && idx === tracks.length - 1)
                return;

            state.currentAudio.idx = (idx + 1) % tracks.length;

            if (state.repeat === 'one')
                state.repeat = 'all';
        },
        previousOne: state => {
            if (!state.currentAudio)
                return;

            const { tracks, idx } = state.currentAudio;
            if (state.repeat === 'off' && idx === 0)
                return;

            state.currentAudio.idx = idx - 1 < 0 ? tracks.length - 1 : idx - 1;

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

export const useCurrentTrack = () => {
    const { currentAudio, shuffleState } = useAudio();

    const currentTrack = useMemo(() => {
        return currentAudio.tracks[
            shuffleState.active ? shuffleState.map[currentAudio.idx] : currentAudio.idx
        ]
    }, [currentAudio, shuffleState]);

    return currentTrack;
}

export default audioSlice;