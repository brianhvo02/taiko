import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const backendApi = createApi({
    reducerPath: 'backendApi',
    baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
    endpoints: (builder) => ({
        getAlbums: builder.query<Omit<Album, 'tracks'>[], void>({
            query: () => '/albums',
        }),
        getAlbumsWithTracks: builder.query<Album[], void>({
            query: () => '/albums?withTracks',
        }),
        getAlbum: builder.query<Album, string>({
            query: albumId => '/albums/' + albumId,
        }),
    }),
});

export const { useGetAlbumsQuery, useGetAlbumQuery } = backendApi;