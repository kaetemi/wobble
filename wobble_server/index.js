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
const MessageTypes = wobbleProtocol.MessageTypes;
const UndefinedMessage = wobbleProtocol.lookupType("UndefinedMessage");
const OpenStream = wobbleProtocol.lookupType("OpenStream");
const WriteFrame = wobbleProtocol.lookupType("WriteFrame");
const CloseStream = wobbleProtocol.lookupType("CloseStream");
const SubscribeStreamList = wobbleProtocol.lookupType("SubscribeStreamList"); 
const PublishStream = wobbleProtocol.lookupType("PublishStream"); 

const accessRights = require("./access_rights.json");

const server = http.createServer({
});

const wss = new WebSocket.Server({ server });

const listSubscribed =  { };
const streams = { };
const streamMap = { };

function publishStream(info) {
    for (let k in listSubscribed) {
        ws.send(buffer);
    }
}

wss.on('connection', function connection(ws) {
    console.log("New connection!");
    streamMap[ws] = { };

    ws.on('message', function incoming(buffer) {
        let undefinedMessage = UndefinedMessage.decode(buffer);
        console.log('Received: ')
        console.log(undefinedMessage);
        switch (undefinedMessage.messageType) {
        case MessageTypes.OPEN_STREAM:
            let openStream = OpenStream.decode(buffer);
            console.log(openStream);
            let name = openStream.info.name;
            let alias = openStream.alias;
            if (accessRights[openStream.info.name].password == openStream.password) {
                let publishStream = {
                    messageType: MessageTypes.PUBLISH_STREAM,
                    info: openStream.info
                };
                let buffer = PublishStream.encode(publishStream).finish();
                streams[name] = {
                    info: openStream.info,
                    publishStream: buffer, // PB of info
                    ws: ws,
                    alias: openStream.alias
                };
                streamMap[ws][alias] = name;
                for (let k in listSubscribed) {
                    ws.send(buffer);
                }
            } else {
                setTimeout(function() { ws.close(); }, 1280); // Bad password
            }
            break;
        case MessageTypes.SUBSCRIBE_STREAM_LIST:
            let subscribeStreamList = SubscribeStreamList.decode(buffer);
            listSubscribed[ws] = true;
            for (let k in streams) {
                ws.send(streams[k].publishStream);
            }
            break;
        }
    });

    ws.on('disconnect', function disconnected() {
        delete streamMap[ws];
        if (listSubscribed[ws]) {
            delete listSubscribed[ws];
        }
    });

    // ws.send('something');
});

server.listen(8090);

/* end of file */
