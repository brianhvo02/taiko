import { Router } from 'express';
import { getAlbum, getAlbums } from '../controllers/albums.js';

const albumsRouter = Router();

albumsRouter.get('/', getAlbums);
albumsRouter.get('/:albumId', getAlbum);

export default albumsRouter;