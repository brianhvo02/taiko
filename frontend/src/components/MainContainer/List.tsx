import './List.scss';
import { useGetAlbumQuery, useGetPlaylistQuery } from '../../store/backend';
import { useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio, useAudio, useCurrentTrack } from '../../store/audio';
import { useDispatch } from 'react-redux';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDuration, secondsToTime } from '../../utils';
import { Button, Dialog, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, useTheme } from '@mui/material';
import { AccessTime, BarChart, Pause, PlayArrow, Album as Disc } from '@mui/icons-material';
import { setHeaderText, setShowHeaderText } from '../../store/layout';

const List = ({ audio }: AudioProps) => {
    const theme = useTheme();
    const { isPlaying } = useAudio();
    const { albumId, playlistId } = useParams();
    const { data: album } = useGetAlbumQuery(albumId ?? skipToken);
    const { data: playlist } = useGetPlaylistQuery(playlistId ?? skipToken);
    const tracks = useMemo(() => (album ?? playlist)?.tracks, [album, playlist]);
    const dispatch = useDispatch();
    const [scrollHeight, setScrollHeight] = useState(0);
    const [hover, setHover] = useState<number | null>(null);
    const [selected, setSelected] = useState<number | null>(null);
    const [showCover, setShowCover] = useState(false);
    const containerRef = useRef<HTMLElement>(null);

    useEffect(() => {
        containerRef.current?.scrollTo({ top: 0 });
        setSelected(null);
    }, [albumId]);

    useEffect(() => {
        dispatch(setHeaderText((album ?? playlist)?.name ?? ''));
    }, [dispatch, album, playlist]);

    useEffect(() => {
        dispatch(setShowHeaderText(scrollHeight >= 245));
    }, [scrollHeight, dispatch]);

    const currentTrack = useCurrentTrack();

    if (!tracks) return null;

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
                onClick={() => setSelected(i)}
                onDoubleClick={() => dispatch(setCurrentAudio({
                    idx: i,
                    tracks,
                }))}
            >
                <TableCell align='right'>
                    { hover === i ? (
                        isPlaying && currentTrack?.track_id === track.track_id ?
                        <Pause 
                            onClick={() => audio.current.pause()}
                            onDoubleClick={(e) => e.stopPropagation()}
                        /> :
                        <PlayArrow 
                            onClick={() => currentTrack?.track_id === track.track_id ? 
                                audio.current.play() : 
                                dispatch(setCurrentAudio({
                                    idx: i,
                                    tracks: tracks,
                                }))
                            } 
                            onDoubleClick={(e) => e.stopPropagation()}
                        />
                    ) : 
                    <span style={
                        currentTrack?.track_id === track.track_id && 
                        currentTrack?.album_id === albumId
                            ? { color: theme.palette.primary.main }
                            : {}
                    }>{ isPlaying && currentTrack?.album_id === albumId && 
                        currentTrack?.track_id === track.track_id ?
                        <BarChart /> :
                        track.track_number
                    }</span> }
                </TableCell>
                <TableCell className='track-title'>
                    <span style={
                        currentTrack?.track_id === track.track_id && 
                        currentTrack?.album_id === albumId
                            ? { color: theme.palette.primary.main }
                            : {}
                    }>{track.title}</span>
                    <span>{track.artists.replaceAll(';', ', ')}</span>
                </TableCell>
                <TableCell align='right'>
                    {secondsToTime(track.duration)}
                </TableCell>
            </TableRow>
        );
        return arr;
    }, []);

    const imagePath = album?.cover_file ?? (playlist ? playlist.id + '.png ': '');

    return (
        <main className='list' ref={containerRef} onScroll={e => setScrollHeight(e.currentTarget.scrollTop)}>
            <Dialog onClose={() => setShowCover(false)} open={showCover} PaperProps={{
                sx: { backgroundColor: 'transparent', boxShadow: 'none', }
            }}>
                <img src={`/images/${imagePath}`} alt='list cover' />
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
                    <Button variant='text' sx={{ 
                        textTransform: 'none', color: theme.palette.text.primary,
                        fontFamily: 'inherit', fontSize: '1rem', fontWeight: '700'
                    }} onClick={() => setShowCover(false)}>Close</Button>
                </div>
            </Dialog>
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
                        <img src={`/images/${imagePath}`} alt='album cover' />
                    </button>
                    <div className='list-info'>
                        <span>Album</span>
                        <span className='list-name'>
                            <h1>{(album ?? playlist)?.name ?? ''}</h1>
                        </span>
                        <div className='additional-info'>
                            { playlist && <>
                            <span>{playlist.owner}</span>
                            <span className='divider'>•</span>
                            </> }
                            { album && <>
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
