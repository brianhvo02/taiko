import './Header.scss';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLayout } from '../../store/layout';
import { Button, Dialog, DialogTitle, FormControl, TextField } from '@mui/material';
import { Close } from '@mui/icons-material';

const Header = () => {
    const navigate = useNavigate();
    const { key } = useLocation();
    const keys = useRef(new Set<string>(['default']));
    const [latestKey, setLatestKey] = useState('default');
    const { showHeaderText, headerText } = useLayout();
    const [showAuth, setShowAuth] = useState<'login' | 'signup' | null>(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');

    useEffect(() => {
        if (key !== latestKey && !keys.current.has(key)) {
            keys.current.add(key);
            setLatestKey(key);
        }
    }, [key, latestKey]);

    return (
        <header className='main-header'>
            <Dialog open={!!showAuth} PaperProps={{ sx: { p: '1rem' }}}>
                <Close 
                    onClick={() => setShowAuth(null)} 
                    sx={{ 
                        alignSelf: 'flex-end', cursor: 'pointer',
                        mr: '1rem', mt: '1rem'
                    }}
                />
                <DialogTitle>{showAuth === 'signup' ? 'Sign Up' : 'Login'}</DialogTitle>
                <FormControl sx={{ gap: '1rem', m: '1rem' }} onSubmit={e => {
                    e.preventDefault();
                    
                }}>
                    { showAuth === 'signup' &&
                    <TextField required label='Display Name' value={displayName} onChange={e => setDisplayName(e.target.value)} /> }
                    <TextField required label='Username' value={username} onChange={e => setUsername(e.target.value)} />
                    <TextField required type="password" label='Password' value={password} onChange={e => setPassword(e.target.value)} />
                    <Button type='submit'>{showAuth === 'login' ? 'Login' : 'Create account'}</Button>
                </FormControl>
            </Dialog>
            <div className='navigation'>
                <button onClick={() => navigate(-1)} disabled={key === 'default'}>
                    <ChevronLeftIcon />
                </button>
                <button onClick={() => navigate(1)} disabled={key === latestKey}>
                    <ChevronRightIcon />
                </button>
                <h1 style={{ opacity: Number(showHeaderText) }}>{headerText}</h1>
            </div>
            <div className='user-details'>
                <button className='white-button' onClick={() => setShowAuth('signup')}>
                    <span>Sign Up</span>
                </button>
                <button className='black-button' onClick={() => setShowAuth('login')}>
                    <span>Login</span>
                </button>
            </div>
        </header>
    );
}

export default Header;
