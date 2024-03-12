import { Link, useLocation } from 'react-router-dom';
import './LeftSidebar.scss';
import HomeIcon from '@mui/icons-material/Home';
import SearchIcon from '@mui/icons-material/Search';
import LibraryIcon from '@mui/icons-material/LocalLibrary';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { useEffect, useRef, useState } from 'react';
import _ from 'lodash';
import { useGetAlbumsQuery } from '../store/backend';

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
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySearchFocus, setLibrarySearchFocus] = useState(false);
    const librarySearchRef = useRef<HTMLInputElement>(null);
    const [sort, setSort] = useState<SortBy>('recents');
    const { data: albums } = useGetAlbumsQuery();
    const location = useLocation();

    useEffect(() => {
        if (librarySearchFocus)
            librarySearchRef.current?.focus();
    }, [librarySearchFocus])

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
                        {albums?.map(({ _id, name, artist, covers}) => {
                            return (
                        <li key={'library-item-' + _id}>
                            <Link to={'/albums/' + _id}>
                                <img src={`/images/${covers[0]}`} alt='album cover' />
                                <div className='item-content'>
                                    <p>{name}</p>
                                    <p>Album • {artist}</p>
                                </div>
                            </Link>
                        </li>
                            );
                        })}
                    </ul>
                </div>
                </div>
        </nav>
    );
}

export default LeftSidebar;
