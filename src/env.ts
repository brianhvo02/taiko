import 'dotenv/config';

if (!process.env.JWT_SECRET)
    throw new Error('Generate a new JWT_SECRET with "npm run generate:secret"');

if (!process.env.LIBRARY_DIR)
    throw new Error('Need path for LIBRARY_DIR');

export const jwtSecret = process.env.JWT_SECRET;
export const libraryDir = process.env.LIBRARY_DIR;