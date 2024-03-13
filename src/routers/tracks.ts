import { Router } from 'express';
import { getTrackAudio } from '../controllers/tracks.js';

const tracksRouter = Router();

tracksRouter.get('/:trackId/audio', getTrackAudio);

export default tracksRouter;