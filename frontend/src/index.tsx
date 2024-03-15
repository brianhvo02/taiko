import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './reset.css';
import './index.scss';
import { Provider } from 'react-redux';
import { store } from './store';
import { experimental_extendTheme as extendTheme, Experimental_CssVarsProvider as CssVarsProvider, ThemeProvider, createTheme, ThemeOptions } from '@mui/material';

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);

const themeOptions: ThemeOptions = {
    palette: {
        mode: 'dark',
        text: {
            primary: '#ffffff',
            secondary: '#a7a7a7',
        },
        primary: {
            main: '#2d89ef',
            200: '#6cacf4',
        },
        background: {
            default: '#121212',
            paper: '#282828',
        },
    },
    components: {
        MuiTableCell: {
            styleOverrides: {
                root: {
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                }
            }
        }
    },
}

const theme = createTheme(themeOptions);
const cssTheme = extendTheme(themeOptions);

root.render(
    <React.StrictMode>
        <CssVarsProvider theme={cssTheme}>
            <ThemeProvider theme={theme}>
                <Provider store={store}>
                    <BrowserRouter>
                        <App />
                    </BrowserRouter>
                </Provider>
            </ThemeProvider>
        </CssVarsProvider>
    </React.StrictMode>
);