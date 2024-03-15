import { createServer } from 'http';
import { db } from './MetadataDatabase.js';
import { app } from './app.js';
import { libraryUpdateServer } from './ws.js';

const server = createServer(app);

server.on('upgrade', (request, socket, head) => {
    if (!request.url) 
        return socket.destroy();
    switch (request.url) {
        case '/libraryUpdates':
            return libraryUpdateServer.handleUpgrade(request, socket, head, ws => {
                ws.emit('connection', ws, request);
            });
        default:
            socket.destroy();
    }
});

const port = process.env.PORT ?? 3050;
server.listen(port, () => console.log('Server listening on port', port));
server.on('close', db.cleanup);