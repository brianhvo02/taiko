import './Home.scss';
import { useGetAlbumsQuery, useGetPlaylistsQuery } from '../../store/backend';
import { useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch } from '../../store/hooks';
import { setHeaderText, setShowHeaderText } from '../../store/layout';

const getTimeOfDay = () => {
    const date = new Date();
    const hours = date.getHours();
    if (hours < 12) {
        return 'morning';
    } else if (hours < 17) {
        return 'afternoon';
    } else if (hours < 20) {
        return 'evening';
    } else {
        return 'night';
    }
}

const isPlaylist = (list: any): list is Omit<Playlist, 'tracks'> => !!list.owner;
const getAttr = (list: Omit<Playlist, "tracks"> | Omit<Album, "tracks">) => 
    isPlaylist(list) ? list.owner : list.artist;

const Home = () => {
    const { currentData: albums } = useGetAlbumsQuery();
    const { currentData: playlists } = useGetPlaylistsQuery();
    const navigate = useNavigate();
    const dispatch = useAppDispatch();
    const [top, setTop] = useState(true);

    useEffect(() => {
        dispatch(setHeaderText('Good ' + getTimeOfDay()));
    }, [dispatch]);

    useEffect(() => {
        dispatch(setShowHeaderText(!top));
    }, [top, dispatch]);

    const lists = useMemo(() => [...(albums ?? []), ...(playlists ?? [])]
        .sort((list1, list2) => getAttr(list1).localeCompare(getAttr(list2)))
        .map(list => {
            const { id, name } = list;
            const imagePath = isPlaylist(list) ? id + '.png' : list.cover_file;
            const attrName = getAttr(list);

            return (
                <li key={id} onClick={() => navigate(`/albums/${id}`)}>
                    <img src={'/images/' + imagePath} alt='album cover' />
                    <h1>{name} {!isPlaylist(list) && `(${list.year.slice(0, 4)})`}</h1>
                    <h2>{attrName}</h2>
                </li>
            );
        }), 
        [albums, navigate, playlists]
    );

    return (
        <main className='home' onScroll={e => setTop(e.currentTarget.scrollTop === 0)}>
            <div className='home-header-spacer' style={top ? {} : { backgroundColor: 'var(--mui-palette-text-primary)', opacity: 1 }} />
            <div className='home-content'>
                <div className='top-gradient' />
                <div className='content-container'>
                    <section className='top'>
                        <h1>Good {getTimeOfDay()}</h1>
                        <ul>{lists}</ul>
                    </section>
                </div>
            </div>
            
        </main>
    );
}

export default Home;
