import { Route, Routes } from 'react-router-dom';
import './index.scss';
import Home from './Home';
import List from './List';
import Header from './Header';
import Footer from './Footer';
import { useLayout } from '../../store/layout';
import { AudioProps } from '../../types/props';

const MainContainer = ({ audio }: AudioProps) => {
    const layout = useLayout();

    return (
        <div className={`main-container${layout.showRightSidebar ? '' : ' right-sidebar-hidden'}`}>
            <Header />
            <Routes>
                <Route path='/' Component={Home} />
                <Route path='/albums/:albumId' element={<List audio={audio}></List>} />
                <Route path='/playlists/:playlistId' element={<List audio={audio}></List>} />
            </Routes>
            <Footer />
        </div>
    );
}

export default MainContainer;
