import { Router } from 'express';
import { addTrack, changeTrackOrder, createPlaylist, getPlaylist, getPlaylists, removeTrack } from '../controllers/playlists.js';

const playlistsRouter = Router();

playlistsRouter.get('/', getPlaylists);
playlistsRouter.post('/', createPlaylist);
playlistsRouter.get('/:playlistId', getPlaylist);
playlistsRouter.post('/:playlistId/track', addTrack);
playlistsRouter.patch('/:playlistId/track', changeTrackOrder);
playlistsRouter.delete('/:playlistId/track', removeTrack);

export default playlistsRouter;