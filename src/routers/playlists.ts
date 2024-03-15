import { Router } from 'express';
import { createPlaylist, getPlaylist, getPlaylists } from '../controllers/playlists.js';

const playlistsRouter = Router();

playlistsRouter.get('/', getPlaylists);
playlistsRouter.post('/', createPlaylist);
playlistsRouter.get('/:playlistId', getPlaylist);

export default playlistsRouter;