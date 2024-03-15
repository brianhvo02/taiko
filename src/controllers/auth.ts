import { NextFunction, Request, Response } from 'express';
import { db } from '../MetadataDatabase.js';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../env.js';

export const getCurrentUser = async (req: Request | string, res?: Response) => {
    const token = typeof req === 'string' ? req : req.headers.authorization;
    if (!token) {
        res && res.status(401).json({ success: false });
        return null;
    }

    const id = jwt.verify(token, jwtSecret);
    if (typeof id !== 'string') {
        res && res.status(422).json({ success: false });
        return null;
    }

    const payload = await db.getUserById(id);

    if (!payload) {
        res && res.status(404).json({ success: false });
        return null;
    }

    res && res.json({ success: true, payload });
    return payload;
}

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.body.displayName || !req.body.username || !req.body.password)
        return res.status(422).json({ success: false });

    const user = await db.createUser({
        display_name: req.body.displayName,
        username: req.body.username,
        password: req.body.password
    });

    if (!user)
        return res.status(400).json({ success: false });
    
    const token = jwt.sign(user.id, jwtSecret);

    res.cookie('token', token).json({ payload: user, success: true });
}

export const loginUser = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.body.username || !req.body.password)
        return res.status(422).json({ success: false });

    const user = await db.getUserByCredentials(req.body);

    if (!user)
        return res.status(401).json({ success: false });

    const token = jwt.sign(user.id, jwtSecret);

    res.cookie('token', token).json({ payload: user, success: true });
}