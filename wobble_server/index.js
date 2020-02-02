'use strict';

// Reference:
// https://github.com/websockets/ws
// https://github.com/protobufjs/protobuf.js#using-json-descriptors

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const protobuf = require("protobufjs");

const wobbleProtocolDescriptor = require("./wobble_protocol.json");
const wobbleProtocol = protobuf.Root.fromJSON(wobbleProtocolDescriptor);
const UndefinedMessage = wobbleProtocol.lookupType("UndefinedMessage");
const OpenStream = wobbleProtocol.lookupType("OpenStream");
const WriteFrame = wobbleProtocol.lookupType("WriteFrame");
const CloseStream = wobbleProtocol.lookupType("CloseStream");

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
