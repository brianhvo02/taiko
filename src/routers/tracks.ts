import { Router } from 'express';
import { getAllTracks } from '../controllers/tracks.js';

const tracksRouter = Router();

tracksRouter.get('/', getAllTracks);

export default tracksRouter;