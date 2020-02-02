'use strict';

// Reference:
// https://github.com/websockets/ws
// https://github.com/protobufjs/protobuf.js#using-json-descriptors
// https://www.npmjs.com/package/long

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
const Subscribe = wobbleProtocol.lookupType("Subscribe");
const Unsubscribe = wobbleProtocol.lookupType("Unsubscribe");
const PublishFrame = wobbleProtocol.lookupType("PublishFrame"); 

const accessRights = require("./access_rights.json");

const server = http.createServer({ });

const wss = new WebSocket.Server({ server });

const listSubscribed =  { };
const streams = { };
const streamMap = { };

wss.on('connection', function connection(ws) {
    console.log("New connection!");
    streamMap[ws] = { };

    ws.on('message', function incoming(buffer) {
        let undefinedMessage = UndefinedMessage.decode(buffer);
        console.log('Received: ')
        console.log(undefinedMessage);
        switch (undefinedMessage.messageType) {
        case MessageTypes.OPEN_STREAM: {
            let openStream = OpenStream.decode(buffer);
            console.log(openStream);
            let name = openStream.info.name;
            let alias = openStream.alias;
            if (accessRights[openStream.info.name].password != openStream.password) {
                setTimeout(function() { ws.close(); }, 1280); // Bad password
                break;
            }
            let publishStream = {
                messageType: MessageTypes.PUBLISH_STREAM,
                info: openStream.info
            };
            let publishBuffer = PublishStream.encode(publishStream).finish();
            let stream =  {
                info: openStream.info,
                publishStream: publishBuffer, // PB of info
                ws: ws,
                alias: openStream.alias,
                receivedSamples: 0,
                open: true,
                subscribed: streams[name] && streams[name].subscribed || { }, // existing or blank
            };
            streams[name] = stream;
            console.log(Object.keys(stream.subscribed).length);
            streamMap[ws][alias] = name;
            for (let k in listSubscribed) {
                k.send(publishBuffer);
            }
            // TODO: Create new output file
            break;
        }
        case MessageTypes.CLOSE_STREAM: {
            let closeStream = CloseStream.decode(buffer);
            console.log(closeStream);
            let alias = closeStream.alias;
            // TODO: Close output file
            delete streamMap[ws][alias];
            break;
        }
        case MessageTypes.WRITE_FRAME: {
            let writeFrame = WriteFrame.decode(buffer);
            console.log(writeFrame);
            let alias = writeFrame.alias;
            let name = streamMap[ws][alias];
            if (!name) {
                setTimeout(function() { ws.close(); }, 1280); // Bad alias
                break;
            }
            if (!writeFrame.channels || !writeFrame.channels.length) {
                setTimeout(function() { ws.close(); }, 1280); // Missing channels
                break;
            }
            let samples = writeFrame.channels[0].length;
            let stream = streams[name];
            let offset = stream.receivedSamples;
            stream.receivedSamples += samples;
            let timestamp = stream.info.timestamp + (stream.receivedSamples / stream.info.frequency);
            let publishFrame = {
                messageType: MessageTypes.PUBLISH_FRAME,
                timestamp: timestamp,
                offset: stream,
                channels: writeFrame.channels,
            };
            let publishBuffer = PublishFrame.encode(publishFrame).finish();
            for (let k in stream.subscribed) {
                k.send(publishBuffer);
            }
            break;
        }
        case MessageTypes.SUBSCRIBE: {
            let subscribe = Subscribe.decode(buffer);
            console.log(subscibe);
            break;
        }
        case MessageTypes.UNSUBSCRIBE: {
            let unsubscribe = Unsubscribe.decode(buffer);
            console.log(unsubscibe);
            break;
        }
        case MessageTypes.SUBSCRIBE_STREAM_LIST: {
            let subscribeStreamList = SubscribeStreamList.decode(buffer);
            console.log(subscribeStreamList);
            listSubscribed[ws] = true;
            for (let k in streams) {
                ws.send(streams[k].publishStream);
            }
            break;
        }
        }
    });

    ws.on('disconnect', function disconnected() {
        // Cleanup
        delete streamMap[ws];
        if (listSubscribed[ws]) {
            delete listSubscribed[ws];
        }
        for (let k in streams) {
            let stream = streams[k];
            if (stream.subscribed[ws]) {
                delete stream.subscribed[ws];
            }
        }
    });
});

server.listen(8090);

/* end of file */
