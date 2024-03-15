import './Header.scss';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { setShowAuth, useLayout } from '../../store/layout';
import { Box, Button, Dialog, DialogTitle, FormHelperText, TextField } from '@mui/material';
import { Close } from '@mui/icons-material';
import { backendApi, useCurrentUser } from '../../store/backend';
import Cookies from 'js-cookie';
import { useAppDispatch } from '../../store/hooks';

const Header = () => {
    const navigate = useNavigate();
    const { key } = useLocation();
    const keys = useRef(new Set<string>(['default']));
    const [latestKey, setLatestKey] = useState('default');
    const { showAuth, showHeaderText, headerText } = useLayout();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState('');
    const dispatch = useAppDispatch();
    const currentUser = useCurrentUser();

    useEffect(() => {
        if (key !== latestKey && !keys.current.has(key)) {
            keys.current.add(key);
            setLatestKey(key);
        }
    }, [key, latestKey]);

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        
        fetch('/api/auth/' + showAuth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, username, password }),
        }).then(res => res.json())
            .then(({ success }) => {
                if (success) {
                    dispatch(setShowAuth(null));
                    dispatch(backendApi.util.invalidateTags(['User']));
                } else {
                    setError(showAuth === 'signup' ? 
                        'Something went wrong.' : 
                        'Invalid username or password.'
                    );
                }
            })
            .catch(e => {
                console.error(e);
                setError(showAuth === 'signup' ? 
                    'Something went wrong.' : 
                    'Invalid username or password.'
                );
            });
    }

    useEffect(() => {
        if (showAuth) return;

        setDisplayName('');
        setUsername('');
        setPassword('');
    }, [showAuth]);

    return (
        <header className='main-header'>
            <Dialog open={!!showAuth} PaperProps={{ sx: { p: '1rem' }}}>
                <Close 
                    onClick={() => dispatch(setShowAuth(null))} 
                    sx={{ 
                        alignSelf: 'flex-end', cursor: 'pointer',
                        mr: '1rem', mt: '1rem'
                    }}
                />
                <DialogTitle>{showAuth === 'signup' ? 'Sign Up' : 'Login'}</DialogTitle>
                <Box component='form' sx={{ 
                    gap: '1rem', m: '1rem', display: 'flex', flexDirection: 'column' 
                }} onSubmit={handleSubmit}>
                    <FormHelperText>{error}</FormHelperText>
                    { showAuth === 'signup' &&
                    <TextField required label='Display Name' value={displayName} autoComplete='display-name'
                        onChange={e => setDisplayName(e.target.value)} /> }
                    <TextField required label='Username' value={username} autoComplete='username'
                        onChange={e => setUsername(e.target.value)} />
                    <TextField required type="password" label='Password' value={password} onChange={e => setPassword(e.target.value)} />
                    <Button type='submit'>{showAuth === 'signup' ? 'Create account' : 'Login'}</Button>
                </Box>
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
                { currentUser ?
                <button className='black-button' onClick={() => {
                    Cookies.remove('token');
                    dispatch(backendApi.util.invalidateTags(['User']));
                }}>
                    <span>Log Out</span>
                </button> : <>
                <button className='white-button' onClick={() => dispatch(setShowAuth('signup'))}>
                    <span>Sign Up</span>
                </button>
                <button className='black-button' onClick={() => dispatch(setShowAuth('login'))}>
                    <span>Login</span>
                </button>
                </> }
            </div>
        </header>
    );
}

export default Header;
