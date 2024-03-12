import './Header.scss';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const Header = () => {
    const navigate = useNavigate();
    const { key } = useLocation();
    const keys = useRef(new Set<string>(['default']));
    const [latestKey, setLatestKey] = useState('default');

    useEffect(() => {
        if (key !== latestKey && !keys.current.has(key)) {
            keys.current.add(key);
            setLatestKey(key);
        }
    }, [key, latestKey]);

    return (
        <header className='main-header'>
            <div className='navigation'>
                <button onClick={() => navigate(-1)} disabled={key === 'default'}>
                    <ChevronLeftIcon />
                </button>
                <button onClick={() => navigate(1)} disabled={key === latestKey}>
                    <ChevronRightIcon />
                </button>
            </div>
            <div className='user-details'>
                <button className='white-button'>
                    <span>Sign Up</span>
                </button>
                <button className='black-button'>
                    <span>Login</span>
                </button>
            </div>
        </header>
    );
}

export default Header;
