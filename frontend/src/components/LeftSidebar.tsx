import { Link, useLocation } from 'react-router-dom';
import './LeftSidebar.scss';
import HomeIcon from '@mui/icons-material/Home';
import SearchIcon from '@mui/icons-material/Search';
import LibraryIcon from '@mui/icons-material/LocalLibrary';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { useEffect, useRef, useState } from 'react';
import _ from 'lodash';
import { useGetAlbumsQuery } from '../store/backend';
import { useTheme } from '@mui/material';
import { useAudio } from '../store/audio';

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

const LeftSidebar = () => {
    const theme = useTheme();
    const { currentAudio, isPlaying } = useAudio();
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySearchFocus, setLibrarySearchFocus] = useState(false);
    const librarySearchRef = useRef<HTMLInputElement>(null);
    const [sort] = useState<SortBy>('recents');
    const { data: albums } = useGetAlbumsQuery();
    const location = useLocation();

    useEffect(() => {
        if (librarySearchFocus)
            librarySearchRef.current?.focus();
    }, [librarySearchFocus]);

    const albumEntries = albums?.reduce((arr: JSX.Element[], { id, name, artist, cover_file }) => {
        if (
            (librarySearch.length > 0 && name.toLowerCase().includes(librarySearch.toLowerCase())) 
            || librarySearch.length === 0
        ) arr.push(
            <li key={'library-item-' + id}>
                <Link to={'/albums/' + id}>
                    <img src={`/images/${cover_file}`} alt='album cover' />
                    <div className='item-content'>
                        <p style={{ color: currentAudio.tracks[currentAudio.idx]?.album_id === id ? 
                            theme.palette.primary.main : theme.palette.text.primary
                        }}>{name}</p>
                        <p>Album <span>•</span> {artist}</p>
                    </div>
                    { currentAudio.tracks[currentAudio.idx]?.album_id === id && isPlaying &&
                    <VolumeUpIcon color='primary' /> }
                </Link>
            </li>
        );

        return arr;
    }, []);

    return (
        <nav className='left-sidebar'>
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
                    <button>
                        <AddIcon />
                    </button>
                    <button>
                        <ArrowForwardIcon />
                    </button>
                </header>
                <div className='library-filters'>
                    <button>Playlists</button>
                    <button>Artists</button>
                    <button>Albums</button>
                </div>
                <div className='item-display'>
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
                    <ul className='library-items'>
                        {albumEntries}
                    </ul>
                </div>
                </div>
        </nav>
    );
}

export default LeftSidebar;
