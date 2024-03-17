import { useRef } from 'react';
import './App.scss';
import { IconButton, Snackbar } from '@mui/material';
import LeftSidebar from './components/LeftSidebar';
import MainContainer from './components/MainContainer';
import NowPlaying from './components/NowPlaying';
import RightSidebar from './components/RightSidebar';
import { setAlertText, useLayout } from './store/layout';
import { useAppDispatch } from './store/hooks';
import { Close } from '@mui/icons-material';

const App = () => {
    const audio = useRef<HTMLAudioElement>(new Audio());
    const { alertText } = useLayout();
    const dispatch = useAppDispatch();

    return (
        <div className='app' onContextMenu={e => e.preventDefault()}>
            <LeftSidebar />
            <NowPlaying audio={audio} />
            <MainContainer audio={audio} />
            <RightSidebar />
            <Snackbar
                open={!!alertText.length}
                autoHideDuration={5000}
                onClose={() => dispatch(setAlertText(''))}
                message={alertText}
                action={
                    <IconButton
                        size="small"
                        aria-label="close"
                        color="inherit"
                        onClick={() => dispatch(setAlertText(''))}
                    >
                        <Close fontSize="small" />
                    </IconButton>
                }
            />
        </div>
    );
}

export default App;
