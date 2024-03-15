import 'dotenv/config';

if (!process.env.JWT_SECRET)
    throw new Error('Generate a new JWT_SECRET with "npm run generate:secret"');

export const jwtSecret = process.env.JWT_SECRET;