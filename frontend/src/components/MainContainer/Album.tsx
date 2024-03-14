import './Album.scss';
import { useGetAlbumQuery } from '../../store/backend';
import { useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio, useAudio, useCurrentTrack } from '../../store/audio';
import { useDispatch } from 'react-redux';
import { useEffect, useRef, useState } from 'react';
import { getDuration, secondsToTime } from '../../utils';
import { Button, Dialog, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, useTheme } from '@mui/material';
import { AccessTime, BarChart, Pause, PlayArrow, Album as Disc } from '@mui/icons-material';
import { setHeaderText, setShowHeaderText } from '../../store/layout';

const Album = ({ audio }: AudioProps) => {
    const theme = useTheme();
    const { isPlaying } = useAudio();
    const { albumId } = useParams();
    const { data: album } = useGetAlbumQuery(albumId ?? skipToken);
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
        dispatch(setHeaderText(album?.name ?? ''));
    }, [dispatch, album]);

    useEffect(() => {
        dispatch(setShowHeaderText(scrollHeight >= 245));
    }, [scrollHeight, dispatch]);

    const currentTrack = useCurrentTrack();

    if (!album) return null;

    const totalDuration = album.tracks.reduce((total, track) => total + track.duration, 0);

    const rows = album.tracks.reduce((arr: JSX.Element[], track, i) => {
        if (album.tracks[album.tracks.length - 1].disc_number > 1 && track.track_number === 1)
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
                    tracks: album.tracks,
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
                                    tracks: album.tracks,
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

    return (
        <main className='album' ref={containerRef} onScroll={e => setScrollHeight(e.currentTarget.scrollTop)}>
            <Dialog onClose={() => setShowCover(false)} open={showCover} PaperProps={{
                sx: { backgroundColor: 'transparent', boxShadow: 'none', }
            }}>
                <img src={`/images/${album.cover_file}`} alt='album cover' />
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
                    <Button variant='text' sx={{ 
                        textTransform: 'none', color: theme.palette.text.primary,
                        fontFamily: 'inherit', fontSize: '1rem', fontWeight: '700'
                    }} onClick={() => setShowCover(false)}>Close</Button>
                </div>
            </Dialog>
            <div className='home-header-spacer' style={scrollHeight >= 245 ? { opacity: 1 } : {}} />
            <div className='album-table-header' style={scrollHeight >= 304 ? { opacity: 1 } : {}}>
                <span>#</span>
                <span>Title</span>
                <span>
                    <AccessTime />
                </span>
            </div>
            <div className='album-content'>
                <div className='top-gradient' />
                <div className='album-meta'>
                    <button onClick={() => setShowCover(true)}>
                        <img src={`/images/${album.cover_file}`} alt='album cover' />
                    </button>
                    <div className='album-info'>
                        <span>Album</span>
                        <span className='album-name'>
                            <h1>{album.name}</h1>
                        </span>
                        <div className='additional-info'>
                            <span>{album.artist}</span>
                            <span className='divider'>•</span>
                            <span>{album.year.slice(0, 4)}</span>
                            <span className='divider'>•</span>
                            <span>{album.tracks.length} songs, {getDuration(totalDuration)}</span>
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

export default Album;
