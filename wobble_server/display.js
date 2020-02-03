'use strict';

// Reference:
// https://javascript.info/websocket

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

let ws;
let createWs;

let safeTimeout = 10;

let streams = { };

function delaySafe(maxTimeout) {
    if (safeTimeout < maxTimeout || 1000) {
        safeTimeout *= 2;
    }
    return safeTimeout;
}

function subscribeStreamList() {
    let message = {
        messageType: MessageType.SUBSCRIBE_STREAM_LIST,
    };
    let buffer = SubscribeStreamList.encode(message).finish();
    ws.send(buffer);
}

let sensorTypes = [
    "Undefined",

    "Accelerometer",
    "Temperature",
    "Humidity",

];

let units = [
    "?",
    "g",
    "°Celsius",
    "Relative Humidity",
]

function publishStream(message) {
    // Fetch all useful data
    let name = message.info.name;
    let description = message.info.description || message.info.name;
    let sensor = sensorTypes[message.info.sensor];
    let hardware = message.info.hardware;
    let unit = units[message.info.unit];
    let channels = [];
    for (let i = 0; i < message.info.channels; ++i) {
        channels[i] = message.info.channelDescriptions[i] || ("[" + i + "]");
    }
    let rows = (streams[name] && streams[name].rows) || [];
    let stream = {
        info: message.info,
        rows: rows,
    };
    streams[name] = stream;
    for (let i = rows.length; i < channels.length; ++i) {
        // Add enough rows
        rows.push(table.insertRow());
    }
    // Update all rows
    // ....
}

function delayReset() {
    safeTimeout = 10;
}

function connected() {
    subscribeStreamList();
}

function disconnected() {
    // ...
}

createWs = function () {
    ws = new WebSocket(location.origin.replace('http', 'ws'));
    ws.binaryType = 'arraybuffer';

    ws.onopen = function (err) {
        console.log("[open] Connection established");
        delayReset();
        connected();
    };

    ws.onmessage = function (event) {
        // console.log(`[message] Data received from server: ${event.data}`);
        // console.log(event);
        let buffer = new Uint8Array(event.data);
        console.log(buffer);
        let undefinedMessage = UndefinedMessage.decode(buffer);
        if (undefinedMessage.messageType != MessageType.PUBLISH_FRAME
            && undefinedMessage.messageType != MessageType.RESULT_FRAME) {
            console.log('Received: ')
            console.log(undefinedMessage);
        }
        switch (undefinedMessage.messageType) {
            case MessageType.PUBLISH_STREAM: {
                let message = PublishStream.decode(buffer);
                console.log(message);
                publishStream(message);
                break;
            }
        }
    };

    ws.onclose = function (event) {
        disconnected();
        if (event.wasClean) {
            console.log(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
        } else {
            console.log('[close] Connection died');
        }
        setTimeout(createWs, delaySafe());
    };

    ws.onerror = function (err) {
        console.log(`[error] ${err.message}`);
    };
};

createWs();

/* end of file */
