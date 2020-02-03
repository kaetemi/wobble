'use strict';

// Reference:
// https://github.com/websockets/ws
// https://github.com/protobufjs/protobuf.js#using-json-descriptors
// https://www.npmjs.com/package/long
// https://stackoverflow.com/questions/34364583/how-to-use-the-write-function-for-wav-module-in-nodejs
// https://medium.com/stackfame/get-list-of-all-files-in-a-directory-in-node-js-befd31677ec5

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

const server = http.createServer({ });

const wss = new WebSocket.Server({ server });

const listSubscribed =  { };
const streams = { };
const streamMap = { };

const compressQueue = { };

function processQueueEntry() {
    let file;
    for (let k in compressQueue) {
        file = k;
        break;
    }
    if (!file) {
        return; // done
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
            fs.unlink(file, function() { });
        }
        setImmediate(processQueueEntry);
	});
}

setInterval(function rotate() {
    // Enforce hourly rotation and compression
    let newFiles = { };
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
    streamMap[ws] = { };

    let heartbeat = setInterval(function ping() {
        ws.ping();
    }, 30000);

    ws.on('message', function incoming(buffer) {
        if (!streamMap[ws]) {
            return; // Can't do anything with late messages
        }
        let undefinedMessage = UndefinedMessage.decode(buffer);
        if (undefinedMessage.messageType != MessageType.WRITE_FRAME) {
            console.log('Received: ')
            console.log(undefinedMessage);
        }
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
                cache: [ ],
                resultDone: ResultDone.encode({
                    messageType: MessageType.RESULT_DONE,
                    name: openStream.info.name,
                }).finish(),
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
            // console.log(writeFrame);
            let alias = writeFrame.alias;
            let name = streamMap[ws][alias];
            if (!name) {
                setTimeout(function() { ws.close(); }, 1280); // Bad alias
                break;
            }
            let stream = streams[name];
            let channels = writeFrame.channels && writeFrame.channels.length;
            if (!channels) {
                setTimeout(function() { ws.close(); }, 1280); // Missing channels
                break;
            }
            if (channels != stream.info.channels) {
                setTimeout(function() { ws.close(); }, 1280); // Mismatching channel count
                break;
            }
            let samples = writeFrame.channels[0].data.length;
            for (let i = 1; i < writeFrame.channels.length; ++i) {
                if (writeFrame.channels[i].data.length != samples) {
                    setTimeout(function() { ws.close(); }, 1280); // Mismatching channel sample counts
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
                k.send(publishBuffer);
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
        case MessageType.QUERY_CACHE: {
            let queryCache = QueryCache.decode(buffer);
            console.log(queryCache);
            let stream = streams[name];
            if (!stream) {
                break; // Bad name
            }
            for (let i = 0; i < stream.cache.length; ++i) {
                ws.send(stream.cache[i]);
            }
            ws.send(stream.resultDone);
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
