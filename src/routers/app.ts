import { Router } from 'express';
import libraryRouter from './library.js';

const appRouter = Router();

appRouter.use('/library', libraryRouter);

export default appRouter;
