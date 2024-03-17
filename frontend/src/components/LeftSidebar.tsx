import { Link, useLocation, useNavigate } from 'react-router-dom';
import './LeftSidebar.scss';
import HomeIcon from '@mui/icons-material/Home';
import SearchIcon from '@mui/icons-material/Search';
import LibraryIcon from '@mui/icons-material/LocalLibrary';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import _ from 'lodash';
import { backendApi, useCurrentUser, useGetAlbumsQuery, useGetPlaylistsQuery } from '../store/backend';
import { Box, Button, Dialog, DialogTitle, FormHelperText, ListItemIcon, ListItemText, Menu, MenuItem, TextField, useTheme } from '@mui/material';
import { useCurrentAudio, useIsPlaying } from '../store/audio';
import { useAppDispatch } from '../store/hooks';
import { setAlertText, setDraggingTrack, setShowAuth, useLayout } from '../store/layout';
import { Close, DeleteOutline } from '@mui/icons-material';
import Cookies from 'js-cookie';

type SortBy = 'recents' | 'recently-added' | 'alphabetical' | 'creator';
const getSortBy = (sortBy: SortBy) => {
    switch (sortBy) {
        case 'recents':
        case 'alphabetical':
        case 'creator':
            return _.capitalize(sortBy);
        case 'recently-added':
            return 'Recently Added';
    }
}

const isPlaylist = (list: any): list is Omit<Playlist, 'tracks'> => !!list.owner;
const getAttr = (list: Omit<Playlist, 'tracks'> | Omit<Album, 'tracks'>) => 
    isPlaylist(list) ? list.owner : list.artist;

const LeftSidebar = () => {
    const theme = useTheme();
    const location = useLocation();
    const navigate = useNavigate();
    const dispatch = useAppDispatch();
    const isPlaying = useIsPlaying();
    const currentAudio = useCurrentAudio();
    const currentUser = useCurrentUser();
    const { draggingTrack } = useLayout();

    const [sort] = useState<SortBy>('recents');
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySearchFocus, setLibrarySearchFocus] = useState(false);
    const [showNewPlaylist, setShowNewPlaylist] = useState(false);
    const [newPlaylistName, setNewPlaylistName] = useState('');
    const [error, setError] = useState('');
    const [dragPlaylist, setDragPlaylist] = useState('');
    const [top, setTop] = useState(true);
    const [showPlaylistDelete, setShowPlaylistDelete] = useState(false);

    const librarySearchRef = useRef<HTMLInputElement>(null);

    const { currentData: albums, isLoading: albumsAreLoading } = useGetAlbumsQuery();
    const { currentData: playlists, isLoading: playlistsAreLoading } = useGetPlaylistsQuery();
    
    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();

        fetch('/api/playlists', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': Cookies.get('token') ?? ''
            },
            body: JSON.stringify({ name: newPlaylistName }),
        }).then(res => res.json())
            .then(({ success, payload }) => {
                if (success) {
                    dispatch(backendApi.util.invalidateTags(['Playlist']));
                    setShowNewPlaylist(false);
                    navigate('/playlists/' + payload);
                } else {
                    setError('Something went wrong.');
                }
            })
            .catch(e => {
                console.error(e);
                setError('Something went wrong.');
            });
    }

    useEffect(() => {
        if (librarySearchFocus)
            librarySearchRef.current?.focus();
    }, [librarySearchFocus]);

    const time = useMemo(() => albumsAreLoading && albums && 
        playlistsAreLoading && playlists && new Date().getTime(), 
        [albums, albumsAreLoading, playlists, playlistsAreLoading]);

    const [contextMenu, setContextMenu] = useState<{
        playlist: Omit<Playlist, 'tracks'>;
        mouseX: number;
        mouseY: number;
    } | null>(null);

    const handleContextMenu = (playlist: Omit<Playlist, 'tracks'> | Omit<Album, 'tracks'>, e: MouseEvent) => {
        e.preventDefault();
        if (!isPlaylist(playlist) || !currentUser) return;

        setContextMenu(
            contextMenu === null ? {
                playlist,
                mouseX: e.clientX + 2,
                mouseY: e.clientY - 6,
            } : null
        );
    };

    const lists = [...(albums ?? []), ...playlists ?? []]
        .sort((list1, list2) => getAttr(list1).localeCompare(getAttr(list2)))
        .reduce((arr: JSX.Element[], list) => {
            const { id, name } = list;

            const imagePath = isPlaylist(list) ? id + '.png' : list.cover_file;
            const attrName = getAttr(list);

            if (
                (librarySearch.length > 0 && name.toLowerCase().includes(librarySearch.toLowerCase())) 
                || librarySearch.length === 0
            ) arr.push(
                <li key={'library-item-' + id} 
                    style={ draggingTrack ? 
                        isPlaylist(list) ? 
                            dragPlaylist === id ? 
                                { border: '2px solid ' + theme.palette.primary.main } : 
                                {} : 
                            { opacity: 0.5 } : 
                        {} }
                    onContextMenu={handleContextMenu.bind(null, list)}
                    onDragOver={e => {
                        if (!e.dataTransfer.types.includes('id')) 
                            return;

                        e.preventDefault();
                        setDragPlaylist(id);
                    }}
                    onDragLeave={() => setDragPlaylist('')}
                    onDragEnd={() => {
                        dispatch(setDraggingTrack(false));
                        setDragPlaylist('');
                    }}
                    onDrop={e => {
                        if (!e.dataTransfer.types.includes('id')) 
                            return;

                        const trackId = e.dataTransfer.getData('id');

                        fetch(`/api/playlists/${id}/track`, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': Cookies.get('token') ?? ''
                            },
                            body: JSON.stringify({ trackId }),
                        }).then(res => res.json())
                            .then(({ success }) => {
                                if (success) {
                                    dispatch(backendApi.util.invalidateTags(['Playlist', { type: 'Playlist', id }]));
                                } else {
                                    dispatch(setAlertText('Couldn\'t add track to playlist (may be a duplicate).'));
                                }
                            })
                            .catch(e => {
                                console.error(e);
                                dispatch(setAlertText('Couldn\'t add track to playlist (may be a duplicate).'));
                            });
                    }}
                >
                    <Link to={(isPlaylist(list) ? '/playlists/' : '/albums/') + id}>
                        <img src={`/images/${imagePath}?t=${time || new Date().getTime()}`} alt='album cover' />
                        <div className='item-content'>
                            <p style={{ color: currentAudio.listId === id ? 
                                theme.palette.primary.main : theme.palette.text.primary
                            }}>{name}</p>
                            <p>{isPlaylist(list) ? 'Playlist' : 'Album'} <span>•</span> {attrName}</p>
                        </div>
                        { currentAudio.listId === id && isPlaying &&
                        <VolumeUpIcon color='primary' /> }
                    </Link>
                </li>
            );

            return arr;
        }, []);

    return (
        <nav className='left-sidebar'>
            <Dialog open={!!showNewPlaylist} PaperProps={{ sx: { p: '1rem' }}}>
                <Close 
                    onClick={() => setShowNewPlaylist(false)} 
                    sx={{ 
                        alignSelf: 'flex-end', cursor: 'pointer',
                        mr: '1rem', mt: '1rem'
                    }}
                />
                <DialogTitle>Create New Playlist</DialogTitle>
                <Box component='form' sx={{ 
                    gap: '1rem', m: '1rem', display: 'flex', flexDirection: 'column' 
                }} onSubmit={handleSubmit}>
                    <FormHelperText>{error}</FormHelperText>
                    <TextField required label='Playlist Name' autoComplete='new-playlist'
                        value={newPlaylistName} onChange={e => setNewPlaylistName(e.target.value)} />
                    <Button type='submit'>Create</Button>
                </Box>
            </Dialog>
            <Menu
                className='list-context'
                open={contextMenu !== null}
                onClose={() => setContextMenu(null)}
                anchorReference='anchorPosition'
                anchorPosition={
                    contextMenu !== null
                        ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
                        : undefined
                }
            >
                { currentUser &&
                <MenuItem onClick={() => setShowPlaylistDelete(true)} sx={{ fontFamily: 'inherit' }}>
                    <ListItemIcon>
                        <DeleteOutline />
                    </ListItemIcon>
                    <ListItemText>Delete playlist</ListItemText>
                </MenuItem>
                }
            </Menu>
            <ul className='nav-list'>
                <li className={location.pathname === '/' ? 'active' : ''}>
                    <Link to='/'>
                        <HomeIcon />
                        <span>Home</span>
                    </Link>
                </li>
                <li className={location.pathname === '/search' ? 'active' : ''}>
                    <Link to='/search'>
                        <SearchIcon />
                        <span>Search</span>
                    </Link>
                </li>
            </ul>
            <div className='library'>
                <header>
                    <button className='library-button'>
                        <LibraryIcon />
                        Your Library
                    </button>
                    <button onClick={() => currentUser ? 
                        setShowNewPlaylist(true) :
                        dispatch(setShowAuth('login'))
                    }>
                        <AddIcon />
                    </button>
                    <button>
                        <ArrowForwardIcon />
                    </button>
                </header>
                <div className='library-filters' style={top ? {} : { 
                    boxShadow: '0 6px 10px rgba(0, 0, 0, 0.6)' 
                }}>
                    <button>Playlists</button>
                    <button>Artists</button>
                    <button>Albums</button>
                </div>
                <div className='item-display' onScroll={e => setTop(e.currentTarget.scrollTop === 0)}>
                    <div className='search-sort'>
                        <div className='search'>
                            <input 
                                role='searchbox' 
                                maxLength={80}
                                autoCorrect='off' 
                                autoCapitalize='off' 
                                spellCheck={false}
                                placeholder='Search in Your Library'
                                value={librarySearch} 
                                tabIndex={-1}
                                ref={librarySearchRef}
                                onChange={e => setLibrarySearch(e.target.value)}
                                onBlur={() => setLibrarySearchFocus(false)}
                                style={
                                    librarySearchFocus ? {
                                        opacity: 1,
                                        padding: '0.5rem',
                                        paddingLeft: '2rem',
                                        width: '11.75rem'
                                    } : {}
                                }
                            />
                            <SearchIcon style={
                                librarySearchFocus ? {
                                    opacity: 1
                                } : {}
                            } />
                            <button onClick={() => setLibrarySearchFocus(true)} style={
                                librarySearchFocus ? {
                                    opacity: 0,
                                    zIndex: -1
                                } : {}
                            }>
                                <SearchIcon />
                            </button>
                        </div>
                        <button className='sort'>
                            {getSortBy(sort)}
                            <FormatListBulletedIcon />
                        </button>
                    </div>
                    <ul className='library-items'>{lists}</ul>
                </div>
                </div>
        </nav>
    );
}

export default LeftSidebar;
