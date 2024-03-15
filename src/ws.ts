import { WebSocket, WebSocketServer } from 'ws';

const sendMessage = async <Payload>(ws: WebSocket, type: string, payload?: Payload) =>
    new Promise<void>((resolve, reject) => ws.send(
        JSON.stringify({ type, payload }), 
        err => err ? reject(err) : resolve()
    ));

export const broadcast = async <Payload>(server: WebSocketServer, type: string, payload?: Payload) =>
    Promise.all([...server.clients].map(async client => sendMessage(client, type, payload)));

export const libraryUpdateServer = new WebSocketServer({ noServer: true });

libraryUpdateServer.on('connection', ws => {
    ws.on('error', console.error);
});

