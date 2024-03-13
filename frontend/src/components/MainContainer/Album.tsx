import './Album.scss';
import { useGetAlbumQuery } from '../../store/backend';
import { useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio } from '../../store/audio';
import { useDispatch } from 'react-redux';
import { useState } from 'react';
import { getDuration, secondsToTime } from '../../utils';
import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import { AccessTime } from '@mui/icons-material';

const Album = () => {
    const { albumId } = useParams();
    const { data: album } = useGetAlbumQuery(albumId ?? skipToken);
    const dispatch = useDispatch();
    const [top, setTop] = useState(true);

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
                        <span className='album-name'>
                            <h1>{album.name}</h1>
                        </span>
                        <div className='additional-info'>
                            <span>{album.artist}</span>
                            <span>{album.year}</span>
                            <span>{album.tracks.length} songs, {getDuration(totalDuration)}</span>
                        </div>
                    </div>
                </div>
                <Table sx={{ minWidth: 650 }} aria-label="simple table">
                    <TableHead>
                        <TableRow>
                            <TableCell align='center'>#</TableCell>
                            <TableCell>Title</TableCell>
                            <TableCell align="right">
                                <AccessTime />
                            </TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                    { album.tracks.map(track => (
                        <TableRow
                            key={track.track_id}
                            sx={{ '&:last-child td, &:last-child th': { border: 0 } }}
                        >
                            <TableCell align='center'>
                                {track.track_number}
                            </TableCell>
                            <TableCell component="th" scope="row">
                                {track.title}
                            </TableCell>
                            <TableCell align="right">{secondsToTime(track.duration)}</TableCell>
                        </TableRow>
                    )) }
                    </TableBody>
                </Table>
                {/* <ul className='tracks'>
                    {album.tracks.map((track, idx) => {
                        return (
                    <li key={track.track_id} 
                        onClick={() => dispatch(setCurrentAudio({
                            idx, track,
                            trackList: album.tracks,
                        }))}>
                        <p className='track-num'>{track.track_number}</p>
                        <p className='title'>{track.title}</p>
                    </li>
                        );
                    })}
                </ul> */}
            </div>
        </main>
    );
}

export default Album;
