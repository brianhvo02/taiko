import express from 'express';
import appRouter from './routers/app.js';

export const app = express();

app.use(express.json());
app.use('/images', express.static('./images'));
app.use('/api', appRouter);