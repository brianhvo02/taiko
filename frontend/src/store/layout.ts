import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';

export interface Layout {
    showRightSidebar: boolean;
    showHeaderText: boolean;
    headerText: string;
}

const initialState: Layout = {
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
    },
})

export const { 
    toggleRightSidebar,
    setShowHeaderText,
    setHeaderText,
} = layoutSlice.actions;

export const useLayout = () => useAppSelector(state => state.layout);

export default layoutSlice;