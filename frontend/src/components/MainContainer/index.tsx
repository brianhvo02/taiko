import { Route, Routes } from 'react-router-dom';
import './index.scss';
import Home from './Home';
import Album from './Album';
import Header from './Header';
import Footer from './Footer';
import { useLayout } from '../../store/layout';

const MainContainer = () => {
    const layout = useLayout();

    return (
        <div className={`main-container${layout.showRightSidebar ? '' : ' right-sidebar-hidden'}`}>
            <Header />
            <Routes>
                <Route path='/' Component={Home} />
                <Route path='/albums/:albumId' Component={Album} />
            </Routes>
            <Footer />
        </div>
    );
}

export default MainContainer;
