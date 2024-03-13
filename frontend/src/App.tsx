import { useRef } from 'react';
import './App.scss';
import LeftSidebar from './components/LeftSidebar';
import MainContainer from './components/MainContainer';
import NowPlaying from './components/NowPlaying';
import RightSidebar from './components/RightSidebar';

const App = () => {
    const audio = useRef<HTMLAudioElement>(new Audio());

    return (
        <div className='app'>
            <LeftSidebar />
            <NowPlaying audio={audio} />
            <MainContainer audio={audio} />
            <RightSidebar />
        </div>
    );
}

export default App;
