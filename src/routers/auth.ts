import { Router } from 'express';
import { createUser, getCurrentUser, loginUser } from '../controllers/auth.js';

const authRouter = Router();

authRouter.get('/', getCurrentUser);
authRouter.post('/login', loginUser);
authRouter.post('/signup', createUser);

export default authRouter;