import { Router } from 'express';
import libraryRouter from './library.js';
import tracksRouter from './tracks.js';
import albumsRouter from './albums.js';
import authRouter from './auth.js';

const appRouter = Router();

appRouter.use('/library', libraryRouter);
appRouter.use('/tracks', tracksRouter);
appRouter.use('/albums', albumsRouter);
appRouter.use('/auth', authRouter);

export default appRouter;
