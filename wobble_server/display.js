'use strict';

// Reference:
// https://javascript.info/websocket
// https://www.w3schools.com/jsref/met_table_insertrow.asp
// https://www.w3schools.com/html/html5_canvas.asp
// https://www.w3schools.com/tags/ref_canvas.asp

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

let streams = {};

let listTable = document.getElementById("list");
let displayTable = document.getElementById("display");

let statusLabel = document.getElementById("status");

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

function subscribe(name) {
    let message = {
        messageType: MessageType.SUBSCRIBE,
        name: name
    };
    let buffer = Subscribe.encode(message).finish();
    ws.send(buffer);
}

function unsubscribe(name) {
    let message = {
        messageType: MessageType.UNSUBSCRIBE,
        name: name
    };
    let buffer = Subscribe.encode(message).finish();
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
    if (!listTable) listTable = document.getElementById("list");
    if (!message.info.channels) {
        console.log("No channels");
        return; // Useless
    }
    let name = message.info.name;
    let description = message.info.description || message.info.name;
    let sensor = sensorTypes[message.info.sensor];
    let hardware = message.info.hardware;
    let unit = units[message.info.unit];
    let rate = message.info.frequency;
    let channels = [];
    for (let i = 0; i < message.info.channels; ++i) {
        channels[i] = message.info.channelDescriptions[i] || ("[" + i + "]");
    }
    let oldStream = streams[name];
    let rows = oldStream ? streams[name].rows : [];
    let stream = {
        info: message.info,
        rows: rows,
        subs: oldStream ? oldStream.subs : 0,
    };
    streams[name] = stream;
    for (let i = rows.length; i < channels.length; ++i) {
        // Add enough rows
        let row = listTable.insertRow();
        let cells = [];
        for (let j = 0; j < 8; ++j) {
            cells.push(row.insertCell());
        }
        rows.push({
            row: row,
            cells: cells,
            displayRow: null,
            displayMinutes: null,
            displaySeconds: null,
            displayScale: null,
            cache: {
                lastSample: null,
            }
        });
    }
    // Update all rows
    rows[0].cells[0].innerHTML = description;
    rows[0].cells[1].innerHTML = sensor;
    rows[0].cells[2].innerHTML = hardware;
    rows[0].cells[3].innerHTML = unit;
    rows[0].cells[4].innerHTML = rate + " Hz";
    for (let i = 0; i < channels.length; ++i) {
        rows[i].cells[5].innerHTML = channels[i];
        rows[i].cells[6].innerHTML = `<button onclick="displayStreamChannel('${name}', ${i})">Display</button>`;
    }
    // Resub
    if (oldStream && oldStream.resub) {
        subscribe(name);
    }
}

function displayStreamChannel(name, channel) {
    if (!displayTable) displayTable = document.getElementById("display");
    let stream = streams[name];
    let row = stream.rows[channel];
    if (row.displayRow) {
        // Unsubscribe
        --stream.subs;
        if (!stream.subs) {
            unsubscribe(name);
        }
        row.displayRow.remove();
        row.displayRow = null;
        row.displayMinutes = null;
        row.displaySeconds = null;
        row.displayScale = null;
    } else {
        // Create canvas
        row.displayRow = displayTable.insertRow();

        let minutesCell = row.displayRow.insertCell();
        minutesCell.setAttribute('bgcolor', '#E0E0E0');
        let minutesCanvas = document.createElement("canvas");
        minutesCanvas.setAttribute('width', 768);
        minutesCanvas.setAttribute('height', 128);
        minutesCell.appendChild(minutesCanvas);
        row.displayMinutes = minutesCanvas;

        let secondsCell = row.displayRow.insertCell();
        secondsCell.setAttribute('bgcolor', '#E0E0E0');
        let secondsCanvas = document.createElement("canvas");
        secondsCanvas.setAttribute('width', 768);
        secondsCanvas.setAttribute('height', 128);
        secondsCell.appendChild(secondsCanvas);
        row.displaySeconds = secondsCanvas;

        let scaleCell = row.displayRow.insertCell();
        scaleCell.setAttribute('bgcolor', '#E0E0E0');
        let scaleCanvas = document.createElement("canvas");
        scaleCanvas.setAttribute('width', 32);
        scaleCanvas.setAttribute('height', 128);
        scaleCell.appendChild(scaleCanvas);
        row.displayScale = scaleCanvas;

        // Subscribe
        if (!stream.subs) {
            subscribe(name);
        }
        ++stream.subs;
    }
} displayStreamChannel;

function publishFrame(message) {
    //console.log(message);
    if (!listTable) listTable = document.getElementById("list");
    if (!displayTable) displayTable = document.getElementById("display");
    let name = message.name;
    let stream = streams[name];
    let rows = stream.rows;
    for (let ch = 0; ch < stream.rows.length; ++ch) {
        if (rows[ch].displayRow) {
            let listRow = rows[ch].row;
            let displayMinutes = rows[ch].displayMinutes;
            let displaySeconds = rows[ch].displaySeconds;
            let cache = rows[ch].cache;
            let data = message.channels[ch].data;
            var ctxMin = displayMinutes.getContext("2d");
            var ctxSec = displaySeconds.getContext("2d");
            let width = 768;
            let height = 128;
            let zero = ~~stream.info.zero[ch];
            if (cache.displayedSamples) {
                // TODO: Shift image left when timestamp skips
                // Shift image left by new samples
                ctxSec.drawImage(displaySeconds, -data.length, 0);
                cache.displayedSamples += data.length;
            } else {
                cache.displayedSamples = data.length;
            }
            // ctxSec.lineWidth = 0.5;
            ctxSec.fillStyle = '#FFFFFF';
            ctxSec.fillRect(width - data.length, 0, data.length, height);
            ctxSec.beginPath();
            if (cache.lastSample != null) {
                ctxSec.moveTo(width - data.length - 1, (height / 2) - (cache.lastSample - zero) * 0.1);
            }
            for (let i = 0; i < data.length; ++i) {
                // TODO: Proper scaling etc
                let x = width - data.length + i;
                let y = (height / 2) - (data[i] - zero) * 0.1;
                if (cache.lastSample == null && i == 0) ctxSec.moveTo(x, y);
                else ctxSec.lineTo(x, y);
            }
            ctxSec.stroke();
            cache.lastSample = data[data.length - 1];
            listRow.cells[7].innerHTML = message.timestamp.toString() + ' ' + cache.lastSample;
        }
    }
}

function delayReset() {
    safeTimeout = 10;
}

function connected() {
    subscribeStreamList();
    if (!statusLabel) statusLabel = document.getElementById("status");
    statusLabel.innerHTML = "Connected";
    // Resubscribe to existing graphs
    for (let k in streams) {
        let stream = streams[k];
        if (stream.subs) {
            stream.resub = true;
        }
    }
}

function disconnected() {
    if (!statusLabel) statusLabel = document.getElementById("status");
    statusLabel.innerHTML = "Disconnected";
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
        // console.log(buffer);
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
            case MessageType.PUBLISH_FRAME: {
                let message = PublishFrame.decode(buffer);
                // console.log(message);
                publishFrame(message);
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
