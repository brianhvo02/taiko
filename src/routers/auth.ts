import { Router } from 'express';
import { createUser, getCurrentUser, getState, loginUser, updateState } from '../controllers/auth.js';

const authRouter = Router();

authRouter.get('/', getCurrentUser);
authRouter.post('/login', loginUser);
authRouter.post('/signup', createUser);
authRouter.get('/state', getState);
authRouter.patch('/state', updateState);

export default authRouter;