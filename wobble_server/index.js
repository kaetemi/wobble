'use strict';

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const server = http.createServer({
});

const wss = new WebSocket.Server({ server });

wss.on('connection', function connection(ws) {
    console.log("New connection!");

    ws.on('message', function incoming(message) {
        console.log('Received: %s', message);
    });

    // ws.send('something');
});

server.listen(8090);

/* end of file */
