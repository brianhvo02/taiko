import { Router } from 'express';
import { updateLibraryRequest } from '../controllers/library.js';

const libraryRouter = Router();

libraryRouter.post('/update', updateLibraryRequest);

export default libraryRouter;