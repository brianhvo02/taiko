import express from 'express';
import appRouter from './routers/app.js';

export const app = express();

app.use(express.json());

if (process.env.NODE_ENV === 'production')
    app.use('/', express.static('./frontend/build'));

app.use('/images', express.static('./images'));
app.use('/api', appRouter);
