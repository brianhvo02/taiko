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

    const info = await db.getUserById(id);

    if (!info) {
        res && res.status(404).json({ success: false });
        return null;
    }

    const state = await db.getUserState(info.id);

    const payload = { info, state };

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
    const state = await db.getUserState(user.id);

    res.cookie('token', token).json({ payload: { user, state }, success: true });
}

export const loginUser = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.body.username || !req.body.password)
        return res.status(422).json({ success: false });

    const user = await db.getUserByCredentials(req.body);

    if (!user)
        return res.status(401).json({ success: false });

    const token = jwt.sign(user.id, jwtSecret);
    const state = await db.getUserState(user.id);

    res.cookie('token', token).json({ payload: { user, state }, success: true });
}

export const getState = async (req: Request, res: Response, next: NextFunction) => {
    const payload = await getCurrentUser(req);
    if (!payload)
        return res.status(401).json({ success: false });

    return res.json({ payload, success: true });
}

export const updateState = async (req: Request, res: Response, next: NextFunction) => {
    const user = await getCurrentUser(req);
    if (!user?.info)
        return res.status(401).json({ success: false });
    
    if (!req.body || !Object.keys(req.body).length) 
        return res.status(422).json({ success: false });
    
    await db.updateUserState(user.info.id, req.body);

    return res.json({ success: true });
}