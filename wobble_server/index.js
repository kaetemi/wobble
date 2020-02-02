'use strict';

// Reference:
// https://github.com/websockets/ws
// https://github.com/protobufjs/protobuf.js#using-json-descriptors
// https://www.npmjs.com/package/long
// https://stackoverflow.com/questions/34364583/how-to-use-the-write-function-for-wav-module-in-nodejs
// https://stackoverflow.com/questions/37794803/node-js-buffer-to-typed-array

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const FileWriter = require('wav').FileWriter;

const wobbleProtocolDescriptor = require("./wobble_protocol.json");
const wobbleProtocol = protobuf.Root.fromJSON(wobbleProtocolDescriptor);

const MessageType = wobbleProtocol.MessageType;
const UndefinedMessage = wobbleProtocol.lookupType("UndefinedMessage");
const OpenStream = wobbleProtocol.lookupType("OpenStream");
const WriteFrame = wobbleProtocol.lookupType("WriteFrame");
const CloseStream = wobbleProtocol.lookupType("CloseStream");
const SubscribeStreamList = wobbleProtocol.lookupType("SubscribeStreamList"); 
const PublishStream = wobbleProtocol.lookupType("PublishStream"); 
const Subscribe = wobbleProtocol.lookupType("Subscribe");
const Unsubscribe = wobbleProtocol.lookupType("Unsubscribe");
const PublishFrame = wobbleProtocol.lookupType("PublishFrame"); 

const config = require("./config.json");
const accessRights = config.accessRights;

const server = http.createServer({ });

const wss = new WebSocket.Server({ server });

const listSubscribed =  { };
const streams = { };
const streamMap = { };

wss.on('connection', function connection(ws) {
    console.log("New connection!");
    streamMap[ws] = { };

    let heartbeat = setInterval(function ping() {
        ws.ping();
    }, 30000);

    ws.on('message', function incoming(buffer) {
        let undefinedMessage = UndefinedMessage.decode(buffer);
        console.log('Received: ')
        console.log(undefinedMessage);
        switch (undefinedMessage.messageType) {
        case MessageType.OPEN_STREAM: {
            let openStream = OpenStream.decode(buffer);
            console.log(openStream);
            let name = openStream.info.name;
            let alias = openStream.alias;
            if (!accessRights[name] || accessRights[name].password != openStream.password) {
                setTimeout(function() { ws.close(); }, 1280); // Bad password
                break;
            }
            if (openStream.info.bits < 1 || openStream.info.bits > 32) {
                setTimeout(function() { ws.close(); }, 1280); // Bad bit depth
                break;
            }
            let publishStream = {
                messageType: MessageType.PUBLISH_STREAM,
                info: openStream.info
            };
            // Create new output file
            let publishBuffer = PublishStream.encode(publishStream).finish();
            let filePath = config.storage + name + "_" + openStream.info.timestamp + ".wav";
            let bitDepth = openStream.info.bits > 16 ? 32 : (openStream.info.bits > 8 ? 16 : 8);
            let fileWriter = new FileWriter(filePath, {
                sampleRate: openStream.info.frequency,
                channels: openStream.info.channels,
                bitDepth: bitDepth,
            });
            // Publish stream to subscribers
            let oldStream = streams[name];
            if (oldStream && oldStream.fileWriter) {
                oldStream.fileWriter.end();
                oldStream.fileWriter.file.end();
                oldStream.fileWriter = null;
            }
            let stream =  {
                info: openStream.info,
                publishStream: publishBuffer, // PB of info
                ws: ws,
                alias: openStream.alias,
                receivedSamples: 0,
                open: true,
                subscribed: oldStream && oldStream.subscribed || { }, // existing or blank
                fileWriter: fileWriter,
                bitDepth: ~~bitDepth, // bit depth for file writer, at least info.bits
                byteDepth: ~~(bitDepth / 8),
            };
            streams[name] = stream;
            console.log(Object.keys(stream.subscribed).length);
            streamMap[ws][alias] = name;
            for (let k in listSubscribed) {
                k.send(publishBuffer);
            }
            break;
        }
        case MessageType.CLOSE_STREAM: {
            let closeStream = CloseStream.decode(buffer);
            console.log(closeStream);
            let alias = writeFrame.alias;
            let name = streamMap[ws][alias];
            if (!name) {
                setTimeout(function() { ws.close(); }, 1280); // Bad alias
                break;
            }
            // Close output file
            let stream = streams[name];
            if (stream.ws == ws) {
                stream.fileWriter.end();
                stream.fileWriter.file.end();
                stream.fileWriter = null;
            }
            // Remove alias
            delete streamMap[ws][alias];
            break;
        }
        case MessageType.WRITE_FRAME: {
            let writeFrame = WriteFrame.decode(buffer);
            console.log(writeFrame);
            let alias = writeFrame.alias;
            let name = streamMap[ws][alias];
            if (!name) {
                setTimeout(function() { ws.close(); }, 1280); // Bad alias
                break;
            }
            let stream = streams[name];
            let channels = writeFrame.channels[0].length;
            if (channels != stream.info.channels) {
                setTimeout(function() { ws.close(); }, 1280); // Mismatching channel count
                break;
            }
            if (!writeFrame.channels || !writeFrame.channels.length) {
                setTimeout(function() { ws.close(); }, 1280); // Missing channels
                break;
            }
            let samples = writeFrame.channels[0].length;
            for (let i = 1; i < writeFrame.channels.length; ++i) {
                if (writeFrame.channels[i].length != samples) {
                    setTimeout(function() { ws.close(); }, 1280); // Mismatching channel sample counts
                    break;
                }
            }
            // Write to file
            let sampleBuffer = Buffer.alloc(channels * samples * stream.byteDepth);
            let sampleView;
            switch (stream.bitDepth) {
                case 32: sampleView = new Int32Array(sampleBuffer); break;
                case 16: sampleView = new Int16Array(sampleBuffer); break;
                case 8: sampleView = new Int8Array(sampleBuffer); break;
            }
            for (let s = 0; s < samples; ++s) {
                for (let c = 0; c < channels; ++c) {
                    sampleView[(s * c) + c] = writeFrame.channels[c][s];
                }
            }
            stream.fileWriter.write(sampleBuffer);
            // Publish frame
            let offset = stream.receivedSamples;
            stream.receivedSamples += samples;
            let timestamp = stream.info.timestamp + (stream.receivedSamples / stream.info.frequency);
            let publishFrame = {
                messageType: MessageType.PUBLISH_FRAME,
                timestamp: timestamp,
                offset: offset,
                channels: writeFrame.channels,
            };
            let publishBuffer = PublishFrame.encode(publishFrame).finish();
            for (let k in stream.subscribed) {
                k.send(publishBuffer);
            }
            break;
        }
        case MessageType.SUBSCRIBE: {
            let subscribe = Subscribe.decode(buffer);
            console.log(subscibe);
            let name = subscribe.name;
            if (!streams[name]) {
                break; // Bad name
            }
            let stream = streams[name];
            stream.subscribed[ws] = true;
            break;
        }
        case MessageType.UNSUBSCRIBE: {
            let unsubscribe = Unsubscribe.decode(buffer);
            console.log(unsubscibe);
            let name = unsubscibe.name;
            if (!streams[name]) {
                break; // Bad name
            }
            let stream = streams[name];
            if (stream.subscribed[ws]) {
                delete streamsubscribed[ws];
            }
            break;
        }
        case MessageType.SUBSCRIBE_STREAM_LIST: {
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

    ws.on('close', function close() {
        // Cleanup
        console.log("Closed connection!");
        delete streamMap[ws];
        clearInterval(heartbeat);
        if (listSubscribed[ws]) {
            delete listSubscribed[ws];
        }
        for (let k in streams) {
            // console.log(k);
            let stream = streams[k];
            if (stream.subscribed[ws]) {
                delete stream.subscribed[ws];
            }
            if (stream.ws == ws) {
                if (stream.fileWriter) {
                    console.log("End stream " + stream.info.name);
                    stream.fileWriter.end();
                    stream.fileWriter.file.end();
                    stream.fileWriter = null;
                }
            }
        }
    });
});

server.listen(8090);

/* end of file */
