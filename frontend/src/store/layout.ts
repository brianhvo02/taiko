import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';

export interface Layout {
    showAuth: 'login' | 'signup' | null;
    showRightSidebar: boolean;
    showHeaderText: boolean;
    headerText: string;
}

const initialState: Layout = {
    showAuth: null,
    showRightSidebar: false,
    showHeaderText: false,
    headerText: '',
}

export const layoutSlice = createSlice({
    name: 'layout',
    initialState,
    reducers: {
        toggleRightSidebar: state => {
            state.showRightSidebar = !state.showRightSidebar;
        },
        setHeaderText: (state, { payload }: PayloadAction<string>) => {
            state.headerText = payload;
        },
        setShowHeaderText: (state, { payload }: PayloadAction<boolean>) => {
            state.showHeaderText = payload;
        },
        setShowAuth: (state, { payload }: PayloadAction<'login' | 'signup' | null>) => {
            state.showAuth = payload;
        },
    },
})

export const { 
    setShowAuth,
    toggleRightSidebar,
    setShowHeaderText,
    setHeaderText,
} = layoutSlice.actions;

export const useLayout = () => useAppSelector(state => state.layout);

export default layoutSlice;