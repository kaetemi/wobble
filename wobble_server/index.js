/*
Copyright (C) 2020  Jan BOON (Kaetemi) <jan.boon@kaetemi.be>
All rights reserved.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

'use strict';

// Reference:
// https://github.com/websockets/ws
// https://github.com/protobufjs/protobuf.js#using-json-descriptors
// https://www.npmjs.com/package/long
// https://stackoverflow.com/questions/34364583/how-to-use-the-write-function-for-wav-module-in-nodejs
// https://medium.com/stackfame/get-list-of-all-files-in-a-directory-in-node-js-befd31677ec5
// https://stackoverflow.com/questions/16333790/node-js-quick-file-server-static-files-over-http

const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const FileWriter = require('wav').FileWriter;
const toBuffer = require('typedarray-to-buffer');
const childProcess = require('child_process');

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
const QueryCache = wobbleProtocol.lookupType("QueryCache");
const ResultFrame = PublishFrame;
const ResultDone = wobbleProtocol.lookupType("ResultDone");

const config = require("./config.json");
const accessRights = config.accessRights;

const whitelist = {
    "/wobble_protocol.json": "/wobble_protocol.json",
    "/": "/index.html",
    "/display.js": "/display.js",
    "/favicon.ico": "/favicon.ico",
};

const mime = {
    ".json": "application/json",
    ".html": "text/html",
    ".js": "text/javascript",
    ".ico": "image/x-icon",
};

const server = http.createServer(function (request, response) {
    console.log(request.method + ' ' + request.url);
    let file = whitelist[request.url];
    if (!file) {
        response.statusCode = 403;
        return response.end('Forbidden');
    }
    let filePath = path.join(".", file);
    let fileExt = path.extname(filePath);
    let contentType = mime[fileExt];
    if (!contentType) {
        response.statusCode = 500;
        return response.end('Bad content type (' + filePath + ', ' + fileExt + ')');
    }
    fs.readFile(filePath, function (err, data) {
        if (err) {
            response.statusCode = 404;
            return response.end('File not found');
        }
        response.setHeader('Content-Type', contentType);
        let d = data;
        if (contentType.startsWith('text/')) {
            d = d.toString();
        }
        if (file == "/display.js") {
            d = d.replace('require("./wobble_protocol.json")', JSON.stringify(wobbleProtocolDescriptor));
        }
        response.end(d);
    });
});

server.on('clientError', function onClientError(err, socket) {
  console.log('clientError', err);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const wss = new WebSocket.Server({ server });
let index = 0;
const wsMap = {};

const listSubscribed = {};
const streams = {};
const streamMap = {};

const compressQueue = {};

function processQueueEntry() {
    let file;
    for (let k in compressQueue) {
        file = k;
        break;
    }
    if (!file) {
        console.log("No more files remaining to compress");
        return; // Done
    }
    delete compressQueue[file];
    console.log("Compress " + file);
    let flacFile = file.substr(0, file.lastIndexOf('.wav')) + '.flac';
    let child = childProcess.exec('ffmpeg -nostdin -y -i ' + config.storage + file + ' ' + config.storage + flacFile, {
        maxBuffer: 1024 * 1024,
        encoding: 0
    });
    child.stderr.pipe(process.stderr);
    child.stdout.on('data', function (d) {
    });
    child.stdout.on('end', function (data) {
    });
    child.on('exit', function (code) {
        if (!code) {
            fs.unlink(config.storage + file, function () { });
        }
        setImmediate(processQueueEntry);
    });
}

setInterval(function rotate() {
    // Enforce hourly rotation and compression
    let newFiles = {};
    for (let k in streams) {
        let stream = streams[k];
        if (stream.fileWriter) {
            let name = stream.info.name;
            console.log("Rotate stream " + name);
            stream.fileWriter.end();
            stream.fileWriter.file.end();
            stream.fileWriter = null;
            let timestamp = stream.info.timestamp.add(1000000 * stream.receivedSamples / stream.info.frequency);
            let filePath = config.storage + name + "_" + timestamp + ".wav";
            newFiles[name + "_" + timestamp + ".wav"] = true;
            let bitDepth = stream.info.bits > 16 ? 32 : (stream.info.bits > 8 ? 16 : 8);
            let fileWriter = new FileWriter(filePath, {
                sampleRate: stream.info.frequency,
                channels: stream.info.channels,
                bitDepth: bitDepth,
            });
            stream.fileWriter = fileWriter;
        }
    }
    // List all .wav files
    fs.readdir(config.storage, function (err, files) {
        if (err) {
            console.log("Unable to list directory")
            return console.log(err);
        }
        // console.log(files);
        for (let i = 0; i < files.length; ++i) {
            let file = files[i];
            // console.log(file);
            if (!newFiles[file] && file.endsWith(".wav")) {
                compressQueue[file] = true;
            }
        }
        // console.log(newFiles);
        // console.log(compressQueue);
        if (files.length) {
            setImmediate(processQueueEntry);
        }
    });
}, 60 * 60 * 1000);

wss.on('connection', function connection(ws) {
    console.log("New connection!");
    ++index;
    ws.wobbleIndex = index;
    wsMap[ws.wobbleIndex] = ws;
    streamMap[ws.wobbleIndex] = {};

    let heartbeat = setInterval(function ping() {
        ws.ping();
    }, 30000);

    ws.on('message', function incoming(buffer) {
        if (!streamMap[ws.wobbleIndex]) {
            return; // Can't do anything with late messages
        }
        let undefinedMessage;
        try {
            undefinedMessage = UndefinedMessage.decode(buffer);
        } catch (err) {
            console.error("Failed to decode new buffer");
            console.error(buffer);
            console.error(err);
            ws.close();
            return;
        }
        if (undefinedMessage.messageType != MessageType.WRITE_FRAME
            && undefinedMessage.messageType != MessageType.PUBLISH_FRAME
            && undefinedMessage.messageType != MessageType.RESULT_FRAME) {
            console.log('Received: ')
            console.log(undefinedMessage);
        }
        switch (undefinedMessage.messageType) {
            case MessageType.OPEN_STREAM: {
                let openStream;
                try {
                    openStream = OpenStream.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode OPEN_STREAM buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(openStream);
                let name = openStream.info.name;
                let alias = openStream.alias;
                if (!accessRights[name] || accessRights[name].password != openStream.password) {
                    setTimeout(function () { ws.close(); }, 1280); // Bad password
                    break;
                }
                if (openStream.info.bits < 1 || openStream.info.bits > 32) {
                    setTimeout(function () { ws.close(); }, 1280); // Bad bit depth
                    break;
                }
                let publishStream = {
                    messageType: MessageType.PUBLISH_STREAM,
                    info: openStream.info
                };
                // Create new output file
                let publishBuffer = PublishStream.encode(publishStream).finish();
                let filePath = config.storage + name.replace(/(\W+)/gi, '_') + "_" + openStream.info.timestamp + ".wav";
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
                let stream = {
                    info: openStream.info,
                    publishStream: publishBuffer, // PB of info
                    ws: ws,
                    alias: openStream.alias,
                    receivedSamples: 0,
                    open: true,
                    subscribed: oldStream ? oldStream.subscribed : {}, // existing or blank
                    fileWriter: fileWriter,
                    bitDepth: ~~bitDepth, // bit depth for file writer, at least info.bits
                    byteDepth: ~~(bitDepth / 8),
                    cache: oldStream ? oldStream.cache : [],
                    resultDone: ResultDone.encode({
                        messageType: MessageType.RESULT_DONE,
                        name: openStream.info.name,
                    }).finish(),
                };
                streams[name] = stream;
                console.log(Object.keys(stream.subscribed).length);
                streamMap[ws.wobbleIndex][alias] = name;
                for (let k in listSubscribed) {
                    let wsc = wsMap[k];
                    if (wsc) {
                        wsc.send(publishBuffer);
                    }
                }
                break;
            }
            case MessageType.CLOSE_STREAM: {
                let closeStream;
                try {
                    closeStream = CloseStream.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode CLOSE_STREAM buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(closeStream);
                let alias = closeStream.alias;
                let name = streamMap[ws.wobbleIndex][alias];
                if (!name) {
                    console.log("Bad alias");
                    setTimeout(function () { ws.close(); }, 1280); // Bad alias
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
                delete streamMap[ws.wobbleIndex][alias];
                break;
            }
            case MessageType.WRITE_FRAME: {
                let writeFrame;
                try {
                    writeFrame = WriteFrame.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode WRITE_FRAME buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                // console.log(writeFrame);
                let alias = writeFrame.alias;
                let name = streamMap[ws.wobbleIndex][alias];
                if (!name) {
                    console.log("Bad alias");
                    setTimeout(function () { ws.close(); }, 1280); // Bad alias
                    break;
                }
                let stream = streams[name];
                let channels = writeFrame.channels && writeFrame.channels.length;
                if (!channels) {
                    console.log("Missing channels");
                    setTimeout(function () { ws.close(); }, 1280); // Missing channels
                    break;
                }
                if (channels != stream.info.channels) {
                    setTimeout(function () { ws.close(); }, 1280); // Mismatching channel count
                    break;
                }
                let samples = writeFrame.channels[0].data.length;
                for (let i = 1; i < writeFrame.channels.length; ++i) {
                    if (writeFrame.channels[i].data.length != samples) {
                        setTimeout(function () { ws.close(); }, 1280); // Mismatching channel sample counts
                        break;
                    }
                }
                // Write to file
                let sampleView;
                switch (stream.bitDepth) {
                    case 32: sampleView = new Int32Array(channels * samples); break;
                    case 16: sampleView = new Int16Array(channels * samples); break;
                    case 8: sampleView = new Int8Array(channels * samples); break;
                }
                for (let s = 0; s < samples; ++s) {
                    for (let c = 0; c < channels; ++c) {
                        sampleView[(s * channels) + c] = writeFrame.channels[c].data[s];
                    }
                }
                let sampleBuffer = toBuffer(sampleView);
                // console.log(sampleBuffer);
                stream.fileWriter.write(sampleBuffer);
                // Publish frame
                let offset = stream.receivedSamples;
                stream.receivedSamples += samples;
                let timestamp = stream.info.timestamp.add(1000000 * stream.receivedSamples / stream.info.frequency);
                let publishFrame = {
                    messageType: MessageType.PUBLISH_FRAME,
                    name: stream.info.name,
                    timestamp: timestamp,
                    offset: offset,
                    channels: writeFrame.channels,
                };
                let publishBuffer = PublishFrame.encode(publishFrame).finish();
                for (let k in stream.subscribed) {
                    let wsc = wsMap[k];
                    if (wsc) {
                        wsc.send(publishBuffer);
                    }
                }
                // Store cache
                publishFrame.messageType = MessageType.RESULT_FRAME;
                let resultBuffer = ResultFrame.encode(publishFrame).finish();
                stream.cache.push({
                    timestamp: timestamp,
                    frame: resultBuffer,
                });
                let timestampDiscard = timestamp.sub(10 * 60 * 1000000); // keep 10 minutes
                while (stream.cache.length && stream.cache[0].timestamp.lessThan(timestampDiscard)) {
                    stream.cache.shift();
                }
                break;
            }
            case MessageType.SUBSCRIBE: {
                let subscribe;
                try {
                    subscribe = Subscribe.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode SUBSCRIBE buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(subscribe);
                let name = subscribe.name;
                if (!streams[name]) {
                    break; // Bad name
                }
                let stream = streams[name];
                stream.subscribed[ws.wobbleIndex] = true;
                break;
            }
            case MessageType.UNSUBSCRIBE: {
                let unsubscribe;
                try {
                    unsubscribe = Unsubscribe.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode UNSUBSCRIBE buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(unsubscribe);
                let name = unsubscribe.name;
                if (!streams[name]) {
                    break; // Bad name
                }
                let stream = streams[name];
                if (stream.subscribed[ws.wobbleIndex]) {
                    delete stream.subscribed[ws.wobbleIndex];
                }
                break;
            }
            case MessageType.SUBSCRIBE_STREAM_LIST: {
                let subscribeStreamList;
                try {
                    subscribeStreamList = SubscribeStreamList.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode SUBSCRIBE_STREAM_LIST buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(subscribeStreamList);
                listSubscribed[ws.wobbleIndex] = true;
                for (let k in streams) {
                    ws.send(streams[k].publishStream);
                }
                break;
            }
            case MessageType.QUERY_CACHE: {
                let queryCache;
                try {
                    queryCache = QueryCache.decode(buffer);
                } catch (err) {
                    console.error("Failed to decode QUERY_CACHE buffer");
                    console.error(buffer);
                    console.error(err);
                    ws.close();
                    return;
                }
                console.log(queryCache);
                let name = queryCache.name;
                let stream = streams[name];
                if (!stream) {
                    break; // Bad name
                }
                for (let i = 0; i < stream.cache.length; ++i) {
                    ws.send(stream.cache[i].frame);
                }
                ws.send(stream.resultDone);
            }
        }
    });

    ws.on('close', function close() {
        // Cleanup
        console.log("Closed connection!");
        delete streamMap[ws.wobbleIndex];
        clearInterval(heartbeat);
        if (listSubscribed[ws.wobbleIndex]) {
            delete listSubscribed[ws.wobbleIndex];
        }
        for (let k in streams) {
            // console.log(k);
            let stream = streams[k];
            if (stream.subscribed[ws.wobbleIndex]) {
                delete stream.subscribed[ws.wobbleIndex];
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
        delete wsMap[ws.wobbleIndex];
    });
});

server.listen(8090);

/* end of file */
