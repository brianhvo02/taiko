import './Home.scss';
import { useGetAlbumsQuery } from '../../store/backend';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

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

const Home = () => {
    const { data: albums } = useGetAlbumsQuery();
    const navigate = useNavigate();
    const [top, setTop] = useState(true);

    return (
        <main className='home' onScroll={e => setTop(e.currentTarget.scrollTop === 0)}>
            <div className='home-header-spacer' style={top ? {} : { backgroundColor: '#121212', opacity: 1 }} />
            <div className='home-content'>
                <div className='top-gradient' />
                <div className='content-container'>
                    <section className='top'>
                        <h1>Good {getTimeOfDay()}</h1>
                        <ul>
                            {albums?.map(({ _id, name, artist, year, covers }) => {
                                return (
                            <li key={_id} onClick={() => navigate(`/albums/${_id}`)}>
                                <img src={'/images/' + covers[0]} alt='album cover' />
                                <h1>{name} ({year})</h1>
                                <h2>{artist}</h2>
                            </li>
                                );
                            })}
                        </ul>
                    </section>
                </div>
            </div>
            
        </main>
    );
}

export default Home;
