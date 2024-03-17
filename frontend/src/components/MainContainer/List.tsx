import './List.scss';
import { backendApi, useCurrentUser, useGetAlbumQuery, useGetPlaylistQuery, useGetPlaylistsQuery } from '../../store/backend';
import { useNavigate, useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio, useCurrentAudio, useCurrentTrack, useIsPlaying } from '../../store/audio';
import { MouseEvent, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBestTextWidth, getDuration, secondsToTime } from '../../utils';
import { 
    Box, Button, CircularProgress, Dialog, DialogTitle, ListItemIcon, ListItemText, Menu, MenuItem, 
    Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, useTheme 
} from '@mui/material';
import { AccessTime, BarChart, Pause, PlayArrow, Album as Disc, Add, Album, DeleteOutline } from '@mui/icons-material';
import { setDraggingTrack, setHeaderText, setShowHeaderText } from '../../store/layout';
import { useAppDispatch } from '../../store/hooks';
import Cookies from 'js-cookie';
import { parseInt } from 'lodash';

const List = ({ audio }: AudioProps) => {
    const theme = useTheme();
    const navigate = useNavigate();
    const dispatch = useAppDispatch();
    const currentAudio = useCurrentAudio();
    const isPlaying = useIsPlaying();
    const { albumId, playlistId } = useParams();
    const { currentData: playlists } = useGetPlaylistsQuery();
    const { currentData: album, isLoading: albumIsLoading } = useGetAlbumQuery(albumId ?? skipToken);
    const { currentData: playlist, isLoading: playlistIsLoading } = useGetPlaylistQuery(playlistId ?? skipToken);
    const tracks = useMemo(() => (albumId ? album : playlist)?.tracks, [album, albumId, playlist]);
    const [scrollHeight, setScrollHeight] = useState(0);
    const [hover, setHover] = useState<number | null>(null);
    const [selected, setSelected] = useState<number | null>(null);
    const [showCover, setShowCover] = useState(false);
    const [showPlaylistAdd, setShowPlaylistAdd] = useState(false);
    const [coverLoading, setCoverLoading] = useState(true);
    const [error, setError] = useState('');
    const containerRef = useRef<HTMLElement>(null);
    const currentUser = useCurrentUser();

    const [dragOver, setDragOver] = useState({
        idx: -1,
        bottom: false,
    });

    const [contextMenu, setContextMenu] = useState<{
        track: Track;
        mouseX: number;
        mouseY: number;
    } | null>(null);
    
    const handleContextMenu = (track: Track, e: MouseEvent) => {
        e.preventDefault();
        if (!playlist && !currentUser) return;

        setContextMenu(
            contextMenu === null ? {
                track,
                mouseX: e.clientX + 2,
                mouseY: e.clientY - 6,
            } : null
        );
    };

    const handlePlaylistAdd = (playlistId: string) => {
        if (!contextMenu) return;

        fetch(`/api/playlists/${playlistId}/track`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': Cookies.get('token') ?? ''
            },
            body: JSON.stringify({ trackId: contextMenu.track.track_id }),
        }).then(res => res.json())
            .then(({ success }) => {
                if (success) {
                    setShowPlaylistAdd(false);
                    setContextMenu(null);
                    dispatch(backendApi.util.invalidateTags(['Playlist', { type: 'Playlist', id: playlistId }]));
                } else {
                    setError('Couldn\'t add track to playlist, may be a duplicate.');
                }
            })
            .catch(e => {
                console.error(e);
                setError('Couldn\'t add track to playlist, may be a duplicate.');
            });
    }

    const handlePlaylistRemove = () => {
        if (!contextMenu) return;

        fetch(`/api/playlists/${playlistId}/track`, {
            method: 'DELETE',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': Cookies.get('token') ?? ''
            },
            body: JSON.stringify({ trackId: contextMenu.track.track_id }),
        }).then(res => res.json())
            .then(({ success }) => {
                if (success) {
                    setContextMenu(null);
                    dispatch(backendApi.util.invalidateTags(['Playlist', { type: 'Playlist', id: playlistId }]));
                } else {
                    setError('Couldn\'t remove track from playlist.');
                }
            })
            .catch(e => {
                console.error(e);
                setError('Couldn\'t remove track from playlist.');
            });
    }

    const [headerFont, setHeaderFont] = useState(0);

    const onResize = useCallback(() => {
        const text = (albumId ? album : playlist)?.name ?? '';
        const newFont = getBestTextWidth(text, window.innerWidth - 720);
        
        setHeaderFont(newFont);
    }, [album, albumId, playlist]);

    useEffect(() => {
        onResize();
        window.addEventListener('resize', onResize);
        
        return () => {
            window.removeEventListener('load', onResize);
            window.removeEventListener('resize', onResize);
        }
    }, [onResize]);

    useEffect(() => {
        containerRef.current?.scrollTo({ top: 0 });
        setSelected(null);
        setError('');
    }, [albumId, playlistId]);

    useEffect(() => {
        dispatch(setHeaderText((albumId ? album : playlist)?.name ?? ''));
    }, [dispatch, albumId, album, playlist]);

    useEffect(() => {
        dispatch(setShowHeaderText(scrollHeight >= 245));
    }, [scrollHeight, dispatch]);

    const currentTrack = useCurrentTrack();

    const listId = albumId ?? playlistId ?? '';

    const listCover = useMemo(() => {
        setCoverLoading(true);
        const coverPath = (albumId ? album?.cover_file : (playlist && playlist.id + '.png')) ?? '';
        const image = createElement('img', {
            width: '100%',
            height: '100%',
            onLoad: () => {
                setCoverLoading(false);
            },
            src: `/images/${coverPath}?t=${new Date().getTime()}`
        });
        return image;
    }, [album, albumId, playlist]);

    if (!tracks || albumIsLoading || playlistIsLoading) return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' }}>
            <CircularProgress size='10rem' />
        </Box>
    );

    if (coverLoading) return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%' }}>
            <CircularProgress size='10rem' />
            <div style={{ opacity: 0, width: 0, height: 0, }}>{listCover}<CircularProgress /></div>
        </Box>
    );

    const totalDuration = tracks.reduce((total, track) => total + track.duration, 0);

    const rows = tracks.reduce((arr: JSX.Element[], track, i) => {
        if (tracks[tracks.length - 1].disc_number > 1 && track.track_number === 1)
            arr.push(
                <TableRow key={`disc_${track.disc_number}`}>
                    <TableCell align='right'>
                        <Disc style={{ color: theme.palette.text.secondary, verticalAlign: 'middle' }} />
                    </TableCell>
                    <TableCell>
                        <span style={{ 
                            fontSize: '1rem', fontWeight: 'bold', paddingBottom: '0.125rem',
                            color: theme.palette.text.secondary
                        }}>Disc {track.disc_number}</span>
                    </TableCell>
                </TableRow>
            );

        arr.push(
            <TableRow 
                key={track.track_id} 
                hover={true}
                selected={selected === i}
                onMouseEnter={() => setHover(i)} 
                onMouseLeave={() => setHover(null)}
                onContextMenu={handleContextMenu.bind(null, track)}
                onClick={() => setSelected(i)}
                onDoubleClick={() => dispatch(setCurrentAudio({
                    tracks, listId,
                    idx: i,
                }))}
                draggable
                onDragStart={e => {
                    dispatch(setDraggingTrack(true));
                    e.dataTransfer.setData('text/plain', `${track.title} • ${track.album}`);
                    e.dataTransfer.setData('id', track.track_id);
                    
                    if (playlistId) 
                        e.dataTransfer.setData('index', `${i}`);
                }}
                onDragOver={e => {
                    if (!e.dataTransfer.types.includes('index')) 
                        return;

                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDragOver({ idx: i, bottom: e.clientY - rect.y > rect.height / 2 });
                }}
                onDragLeave={() => setDragOver({ idx: -1, bottom: false })}
                onDragEnd={() => {
                    dispatch(setDraggingTrack(false));
                    setDragOver({ idx: -1, bottom: false });
                }}
                onDrop={e => {
                    if (!e.dataTransfer.types.includes('index'))
                        return;

                    const tempTracks = [...tracks];
                    const currentIdx = parseInt(e.dataTransfer.getData('index'));
                    const nextIdx = dragOver.idx + Number(dragOver.bottom);

                    if (currentIdx === nextIdx || currentIdx + 1 === nextIdx)
                        return;

                    const [selectedTrack] = tempTracks.splice(currentIdx, 1);
                    tempTracks.splice(currentIdx < nextIdx ? nextIdx - 1 : nextIdx, 0, selectedTrack);
                    const trackOrder = tempTracks.map(track => track.track_id).join('');
                    
                    fetch(`/api/playlists/${playlistId}/track`, {
                        method: 'PATCH',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': Cookies.get('token') ?? ''
                        },
                        body: JSON.stringify({ trackOrder }),
                    }).then(res => res.json())
                        .then(({ success }) => {
                            if (success) {
                                dispatch(backendApi.util.invalidateTags(['Playlist', { type: 'Playlist', id: playlistId }]));
                            } else {
                                console.error('Couldn\'t change track order.')
                            }
                        })
                        .catch(e => {
                            console.error(e);
                            console.error('Couldn\'t change track order.')
                        });
                }}
                sx={ dragOver.idx === i ? 
                    { [ dragOver.bottom ? 'borderBottom' : 'borderTop'
                        ]: '1px solid ' + theme.palette.primary.main } : 
                    {} }
            >
                <TableCell align='right'>
                    { hover === i ? (
                        isPlaying && currentTrack?.track_id === track.track_id && 
                        listId ===  currentAudio.listId ?
                        <Pause 
                            onClick={() => audio.current.pause()}
                            onDoubleClick={(e) => e.stopPropagation()}
                        /> :
                        <PlayArrow 
                            onClick={() => currentTrack?.track_id === track.track_id ? 
                                audio.current.play() : 
                                dispatch(setCurrentAudio({
                                    listId,
                                    idx: i,
                                    tracks: tracks,
                                }))
                            } 
                            onDoubleClick={(e) => e.stopPropagation()}
                        />
                    ) : 
                    <span style={
                        currentTrack?.track_id === track.track_id && 
                        currentAudio.listId === listId
                            ? { color: theme.palette.primary.main }
                            : {}
                    }>{ isPlaying && currentAudio.listId === listId && 
                        currentTrack?.track_id === track.track_id ?
                        <BarChart /> :
                        (albumId ? track.track_number : i + 1)
                    }</span> }
                </TableCell>
                <TableCell className='track-title'>
                    { playlistId &&
                    <img src={'/images/' + track.cover_file} alt='album cover' /> }
                    <div>
                        <span style={
                            currentTrack?.track_id === track.track_id && 
                            currentAudio.listId === listId
                                ? { color: theme.palette.primary.main }
                                : {}
                        }>{track.title}</span>
                        <span>{track.artists.replaceAll(';', ', ')}</span>
                    </div>
                </TableCell>
                { playlistId &&
                    <TableCell>
                        {track.album}
                    </TableCell>
                }
                <TableCell align='right'>
                    {secondsToTime(track.duration)}
                </TableCell>
            </TableRow>
        );

        return arr;
    }, []);

    return (
        <main className='list' ref={containerRef} onScroll={e => setScrollHeight(e.currentTarget.scrollTop)}>
            <Dialog onClose={() => setShowCover(false)} open={showCover} PaperProps={{
                sx: { backgroundColor: 'transparent', boxShadow: 'none', }
            }}>
                {listCover}
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
                    <Button variant='text' sx={{ 
                        textTransform: 'none', color: theme.palette.text.primary,
                        fontFamily: 'inherit', fontSize: '1rem', fontWeight: '700'
                    }} onClick={() => setShowCover(false)}>Close</Button>
                </div>
            </Dialog>
            <Dialog onClose={() => {
                setShowPlaylistAdd(false);
                setContextMenu(null);
            }} open={showPlaylistAdd} PaperProps={{ sx: { p: '1rem' } }}>
                <DialogTitle sx={{ mb: 1 }}>Select playlist to add "{contextMenu?.track.title}"</DialogTitle>
                <p>{error}</p>
                <TextField label='Find a playlist' autoComplete='playlists' />
                <ul className='playlist-selection'>
                    { playlists?.map(playlist => {
                        return (
                    <li key={playlist.id} onClick={handlePlaylistAdd.bind(null, playlist.id)}>
                        <span>{playlist.name}</span>
                    </li>
                        )
                    }) }
                </ul>
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
                <MenuItem onClick={() => setShowPlaylistAdd(true)} sx={{ fontFamily: 'inherit' }}>
                    <ListItemIcon>
                        <Add />
                    </ListItemIcon>
                    <ListItemText>Add to playlist</ListItemText>
                </MenuItem>
                }
                { playlistId && currentUser &&
                <MenuItem onClick={handlePlaylistRemove} sx={{ fontFamily: 'inherit' }}>
                    <ListItemIcon>
                        <DeleteOutline />
                    </ListItemIcon>
                    <ListItemText>Remove from this playlist</ListItemText>
                </MenuItem> }
                { playlistId &&
                <MenuItem onClick={() => {
                    setContextMenu(null);
                    navigate('/albums/' + contextMenu?.track.album_id);
                }} sx={{ fontFamily: 'inherit' }}>
                    <ListItemIcon>
                        <Album />
                    </ListItemIcon>
                    <span>Go to album</span>
                </MenuItem> }
            </Menu>
            <div className='home-header-spacer' style={scrollHeight >= 245 ? { opacity: 1 } : {}} />
            <div className='list-table-header' style={scrollHeight >= 304 ? { opacity: 1 } : {}}>
                <span>#</span>
                <span>Title</span>
                <span>
                    <AccessTime />
                </span>
            </div>
            <div className='list-content'>
                <div className='top-gradient' />
                <div className='list-meta'>
                    <button onClick={() => setShowCover(true)}>
                        {listCover}
                    </button>
                    <div className='list-info'>
                        <span>{albumId ? 'Album' : 'Playlist'}</span>
                        <span className='list-name'>
                            <h1 style={{ fontSize: `${headerFont}px` }}>{(albumId ? album : playlist)?.name ?? ''}</h1>
                        </span>
                        <div className='additional-info'>
                            { playlistId && playlist && <>
                            <span>{playlist.owner}</span>
                            <span className='divider'>•</span>
                            </> }
                            { albumId && album && <>
                            <span>{album.artist}</span>
                            <span className='divider'>•</span>
                            <span>{album.year.slice(0, 4)}</span>
                            <span className='divider'>•</span>
                            </> }
                            <span>{tracks.length} songs, {getDuration(totalDuration)}</span>
                        </div>
                    </div>
                </div>
                <TableContainer className='tracks'>
                    <Table>
                        <TableHead>
                            <TableRow>
                                <TableCell align='right'>
                                    #
                                </TableCell>
                                <TableCell>
                                    Title
                                </TableCell>
                                { playlistId &&
                                    <TableCell>
                                        Album
                                    </TableCell>
                                }
                                <TableCell align='right'>
                                    <AccessTime />
                                </TableCell>
                            </TableRow>
                            <TableRow className='spacer'>
                                <TableCell align='right' />
                                <TableCell />
                                <TableCell align='right' />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows}
                        </TableBody>
                    </Table>
                </TableContainer>
            </div>
        </main>
    );
}

export default List;
