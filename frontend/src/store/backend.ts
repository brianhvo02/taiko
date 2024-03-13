import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const backendApi = createApi({
    reducerPath: 'backendApi',
    baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
    endpoints: (builder) => ({
        getAlbums: builder.query<Omit<Album, 'tracks'>[], void>({
            query: () => '/albums',
            transformResponse: (res: Query<Omit<Album, 'tracks'>[]>) => res.success ? res.payload : []
        }),
        getAlbumsWithTracks: builder.query<Album[], void>({
            query: () => '/albums?withTracks',
            transformResponse: (res: Query<Album[]>) => res.success ? res.payload : []
        }),
        getAlbum: builder.query<Album | null, string>({
            query: albumId => '/albums/' + albumId,
            transformResponse: (res: Query<Album>) => res.success ? res.payload : null
        }),
    }),
});

export const { useGetAlbumsQuery, useGetAlbumQuery } = backendApi;