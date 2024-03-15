import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import Cookies from 'js-cookie';

export const backendApi = createApi({
    reducerPath: 'backendApi',
    baseQuery: fetchBaseQuery({ 
        baseUrl: '/api', 
        prepareHeaders: headers => {
            headers.set('Authorization', Cookies.get('token') ?? '');
        }
    }),
    tagTypes: ['User', 'Album', 'Playlist'],
    endpoints: (builder) => ({
        getPlaylists: builder.query<Omit<Playlist, 'tracks'>[], void>({
            query: () => '/playlists',
            providesTags: result => result ? [
                ...result.map(({ id }) => ({ type: 'Playlist' as const, id })), 'Playlist'
            ] : ['Playlist'],
            transformResponse: (res: Query<Omit<Playlist, 'tracks'>[]>) => res.success ? res.payload : []
        }),
        getPlaylist: builder.query<Playlist | null, string>({
            query: albumId => '/albums/' + albumId,
            providesTags: result => result ? [{ type: 'Playlist', id: result.id }, 'Playlist'] : ['Playlist'],
            transformResponse: (res: Query<Playlist>) => res.success ? res.payload : null
        }),
        getAlbums: builder.query<Omit<Album, 'tracks'>[], void>({
            query: () => '/albums',
            providesTags: result => result ? [
                ...result.map(({ id }) => ({ type: 'Album' as const, id })), 'Album'
            ] : ['Album'],
            transformResponse: (res: Query<Omit<Album, 'tracks'>[]>) => res.success ? res.payload : []
        }),
        getAlbumsWithTracks: builder.query<Album[], void>({
            query: () => '/albums?withTracks',
            providesTags: result => result ? [
                ...result.map(({ id }) => ({ type: 'Album' as const, id })), 'Album'
            ] : ['Album'],
            transformResponse: (res: Query<Album[]>) => res.success ? res.payload : []
        }),
        getAlbum: builder.query<Album | null, string>({
            query: albumId => '/albums/' + albumId,
            providesTags: result => result ? [{ type: 'Album', id: result.id }, 'Album'] : ['Album'],
            transformResponse: (res: Query<Album>) => res.success ? res.payload : null
        }),
        getCurrentUser: builder.query<User | null, void>({
            query: () => '/auth',
            providesTags: ['User'],
            transformResponse: (res: Query<User>) => res.success ? res.payload : null
        }),
    }),
});

export const { useGetPlaylistsQuery, useGetPlaylistQuery, useGetAlbumsQuery, useGetAlbumQuery, useGetCurrentUserQuery, } = backendApi;
export const useCurrentUser = () => {
    const { data, isSuccess } = useGetCurrentUserQuery();

    return (isSuccess && data) ? data : null;
}