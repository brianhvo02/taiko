import './Album.scss';
import { useGetAlbumQuery } from '../../store/backend';
import { useParams } from 'react-router-dom';
import { skipToken } from '@reduxjs/toolkit/query';
import { setCurrentAudio } from '../../store/audio';
import { useDispatch } from 'react-redux';
import _ from 'lodash';
import { useState } from 'react';
import { getDuration } from '../../utils';

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
                        <img src={`/images/${album.covers[0]}`} alt='album cover' />
                    </button>
                    <div className='album-info'>
                        <h1>{album.name}</h1>
                        <div className='additional-info'>
                            <span>{album.artist}</span>
                            <span>{album.year}</span>
                            <span>{album.tracks.length} songs, {getDuration(totalDuration)}</span>
                        </div>
                    </div>
                </div>
                {/* <ul className='tracks'>
                    {album.tracks.map((track, idx) => {
                        return (
                    <li key={track._id} 
                        onClick={() => dispatch(setCurrentAudio({
                            idx, track,
                            album: _.omit(album, 'tracks'),
                            trackList: album.tracks,
                        }))}>
                        <p className='disc-num'>{track.discNum}</p>
                        <p className='track-num'>{track.trackNum}</p>
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
