import './App.scss';
import LeftSidebar from './components/LeftSidebar';
import MainContainer from './components/MainContainer';
import NowPlaying from './components/NowPlaying';
import RightSidebar from './components/RightSidebar';

const App = () => {
    return (
        <div className='app'>
            <LeftSidebar />
            <NowPlaying />
            <MainContainer />
            <RightSidebar />
        </div>
    );
}

export default App;
