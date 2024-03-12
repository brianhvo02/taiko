import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { AlbumWithArtist, AlbumWithTracks } from '../../../src/types';

export const backendApi = createApi({
    reducerPath: 'backendApi',
    baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
    endpoints: (builder) => ({
        getAlbums: builder.query<AlbumWithArtist[], void>({
            query: () => '/albums?includeArtist=true',
        }),
        getAlbum: builder.query<AlbumWithTracks, string>({
            query: albumId => '/albums/' + albumId,
        }),
    }),
});

export const { useGetAlbumsQuery, useGetAlbumQuery } = backendApi;