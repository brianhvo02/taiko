import { Router } from 'express';
import libraryRouter from './library.js';
import tracksRouter from './tracks.js';
import albumsRouter from './albums.js';

const appRouter = Router();

appRouter.use('/library', libraryRouter);
appRouter.use('/tracks', tracksRouter);
appRouter.use('/albums', albumsRouter);

export default appRouter;
