import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';

export interface Layout {
    showRightSidebar: boolean;
}

const initialState: Layout = {
    showRightSidebar: false,
}

export const layoutSlice = createSlice({
    name: 'layout',
    initialState,
    reducers: {
        toggleRightSidebar: state => {
            state.showRightSidebar = !state.showRightSidebar;
        },
    },
})

export const { 
    toggleRightSidebar
} = layoutSlice.actions;

export const useLayout = () => useAppSelector(state => state.layout);

export default layoutSlice;