import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { backendApi } from './backend';
import audioSlice from './audio';
import layoutSlice from './layout';

export const store = configureStore({
    reducer: {
        [backendApi.reducerPath]: backendApi.reducer,
        [audioSlice.reducerPath]: audioSlice.reducer,
        [layoutSlice.reducerPath]: layoutSlice.reducer,
    },
    middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(backendApi.middleware),
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;