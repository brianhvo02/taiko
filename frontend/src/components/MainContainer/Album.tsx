import './Album.scss';
import { useGetAlbumQuery } from '../../store/backend';
import { useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio, useAudio } from '../../store/audio';
import { useDispatch } from 'react-redux';
import { useState } from 'react';
import { getDuration, secondsToTime } from '../../utils';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableRow, useTheme } from '@mui/material';
import { AccessTime, BarChart, Pause, PlayArrow } from '@mui/icons-material';

const Album = ({ audio }: AudioProps) => {
    const theme = useTheme();
    const { currentAudio, isPlaying } = useAudio();
    const { albumId } = useParams();
    const { data: album } = useGetAlbumQuery(albumId ?? skipToken);
    const dispatch = useDispatch();
    const [top, setTop] = useState(true);
    const [hover, setHover] = useState<number | null>(null);
    const [selected, setSelected] = useState<number | null>(null);

    if (!album) return null;

    const totalDuration = album.tracks.reduce((total, track) => total + track.duration, 0);

    return (
        <main className='album' onScroll={e => setTop(e.currentTarget.scrollTop === 0)}>
            <div className='home-header-spacer' style={top ? {} : { backgroundColor: '#121212', opacity: 1 }} />
            <div className='album-content'>
                <div className='top-gradient' />
                <div className='album-meta'>
                    <button>
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
                            <span>{album.year}</span>
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
                        { album.tracks.map((track, i) => (
                            <TableRow 
                                key={track.track_id} 
                                hover={true}
                                selected={selected === i}
                                onMouseEnter={() => setHover(i)} 
                                onMouseLeave={() => setHover(null)}
                                onClick={() => setSelected(i)}
                                onDoubleClick={() => dispatch(setCurrentAudio({
                                    track, idx: i,
                                    trackList: album.tracks,
                                }))}
                            >
                                <TableCell align='right'>
                                    { hover === i ? (
                                        isPlaying && currentAudio?.idx === i ?
                                        <Pause 
                                            onClick={() => audio.current.pause()}
                                            onDoubleClick={(e) => e.stopPropagation()}
                                        /> :
                                        <PlayArrow 
                                            onClick={() => currentAudio?.idx === i ? 
                                                audio.current.play() : 
                                                dispatch(setCurrentAudio({
                                                    track, idx: i,
                                                    trackList: album.tracks,
                                                }))
                                            } 
                                            onDoubleClick={(e) => e.stopPropagation()}
                                        />
                                    ) : 
                                    <span style={
                                        currentAudio?.idx === i
                                            ? { color: theme.palette.primary.main }
                                            : {}
                                    }>{ isPlaying && currentAudio?.idx === i ?
                                        <BarChart /> :
                                        track.track_number
                                    }</span> }
                                </TableCell>
                                <TableCell className='track-title'>
                                    <span style={
                                        currentAudio?.idx === i
                                            ? { color: theme.palette.primary.main }
                                            : {}
                                    }>
                                        {track.title}
                                    </span>
                                    <span>{track.artists.replaceAll(';', ', ')}</span>
                                </TableCell>
                                <TableCell align='right'>
                                    {secondsToTime(track.duration)}
                                </TableCell>
                            </TableRow>
                        )) }
                        </TableBody>
                    </Table>
                </TableContainer>
            </div>
        </main>
    );
}

export default Album;
