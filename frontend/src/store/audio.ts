import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';
import { MutableRefObject, useMemo } from 'react';
import _ from 'lodash';
import { backendApi } from './backend';
import Cookies from 'js-cookie';

const REPEAT_MODES = ['off', 'all', 'one'] as const;


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

export const updateRemoteState = (state: Partial<AudioState>) => {
    const auth = Cookies.get('token');

    if (!auth)
        return;

    return fetch('/api/auth/state', {
        method: 'PATCH',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': auth
        },
        body: JSON.stringify(state)
    }).then(res => res.json());
}

export const audioSlice = createSlice({
    name: 'audio',
    initialState,
    reducers: {
        setCurrentAudio: (state, { payload }: PayloadAction<AudioState['currentAudio']>) => {
            if (state.shuffleState.active) {
                const { idx, tracks, listId } = payload;
                const indices = [...Array(tracks.length).keys()];
                state.shuffleState.map = _.shuffle(indices.slice(0, idx).concat(indices.slice(idx + 1, tracks.length)));
                state.shuffleState.map.unshift(idx);
                state.currentAudio = {
                    listId, tracks,
                    idx: 0,
                }

                updateRemoteState({ currentAudio: state.currentAudio, shuffleState: state.shuffleState });

                return;
            }

            state.currentAudio = payload;
            updateRemoteState({ currentAudio: payload });
        },
        setElapsed: (state, { payload }: PayloadAction<number>) => {
            if (Math.floor(payload) % 5 === 0 && Math.floor(payload) - Math.floor(state.elapsed) === 1) 
                updateRemoteState({ elapsed: payload });

            state.elapsed = payload;
        },
        setDuration: (state, { payload }: PayloadAction<number>) => {
            state.duration = payload;
            updateRemoteState({ duration: payload });
        },
        toggleIsPlaying: state => {
            state.isPlaying = !state.isPlaying;
        },
        setIsPlaying: (state, { payload }: PayloadAction<boolean>) => {
            state.isPlaying = payload;

            if (!payload)
                updateRemoteState({ elapsed: state.elapsed });
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

            updateRemoteState({ currentAudio: state.currentAudio, shuffleState: state.shuffleState });
        },
        toggleRepeat: state => {
            const repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % 3];
            state.repeat = repeat;
            updateRemoteState({ repeat });
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

            updateRemoteState({ currentAudio: state.currentAudio, repeat: state.repeat });
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

            updateRemoteState({ currentAudio: state.currentAudio, repeat: state.repeat });
        },
        setVolume: (state, { payload }: PayloadAction<number>) => {
            state.volume = payload;
            if (payload > 0 && state.volumeMemory !== null)
                state.volumeMemory = null;

            updateRemoteState({ volume: payload });
        },
        toggleMute: (state, { payload }: PayloadAction<MutableRefObject<HTMLAudioElement>>) => {
            if (state.volume > 0 && state.volumeMemory === null) {
                state.volumeMemory = state.volume;
                payload.current.volume = 0;
                updateRemoteState({ volume: 0 });
            } else {
                const newVolume = (state.volumeMemory ?? 0) / 100;
                payload.current.volume = newVolume;
                state.volumeMemory = null;
                updateRemoteState({ volume: newVolume });
            }
        }
    },
    extraReducers: builder => {
        builder.addMatcher(backendApi.endpoints.getCurrentUser.matchFulfilled, (state, action) => {
            if (action.payload?.state && !_.isEqual(initialState, action.payload.state) && _.isEqual(initialState, state))
                return action.payload.state;

            if (!_.isEqual(initialState, state))
                updateRemoteState(state);
        });
    }
})

export const { 
    setCurrentAudio, setElapsed, setDuration, setIsPlaying,
    toggleIsPlaying, toggleShuffle, toggleRepeat,
    forwardOne, previousOne, setVolume, toggleMute
} = audioSlice.actions;

export const useAudio = () => useAppSelector(state => state.audio);
export const useCurrentAudio = () => useAppSelector(state => state.audio.currentAudio);
export const useShuffleState = () => useAppSelector(state => state.audio.shuffleState);
export const useIsPlaying = () => useAppSelector(state => state.audio.isPlaying);

export const useCurrentTrack = () => {
    const currentAudio = useCurrentAudio();
    const shuffleState = useShuffleState();

    const currentTrack = useMemo(() => {
        return currentAudio.tracks[
            shuffleState.active ? shuffleState.map[currentAudio.idx] : currentAudio.idx
        ]
    }, [currentAudio, shuffleState]);

    return currentTrack;
}

export default audioSlice;