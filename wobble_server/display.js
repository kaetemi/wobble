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

function updateScale(name, channel) {
    const stream = streams[name];
    const rows = stream.rows;
    const row = rows[channel];
    const listRow = row.row;
    const scaleCanvas = row.displayScale;
    const scaleCell = listRow.cells[7];
    const cache = row.cache;
    const zoom = cache.zoom;
    const scale = stream.info.scale / zoom;
    const unit = units[stream.info.unit];
    const scaleText = "±" + scale + unit;
    listRow.cells[7].innerHTML = scaleText;
}

function publishStream(message) {
    // Fetch all useful data
    if (!listTable) listTable = document.getElementById("list");
    if (!message.info.channels) {
        console.log("No channels");
        return; // Useless
    }
    const name = message.info.name;
    const description = message.info.description || message.info.name;
    const sensor = sensorTypes[message.info.sensor];
    const hardware = message.info.hardware;
    const unit = units[message.info.unit];
    const rate = message.info.frequency;
    const zoom = message.info.zoom;
    const channels = [];
    for (let i = 0; i < message.info.channels; ++i) {
        channels[i] = message.info.channelDescriptions[i] || ("[" + i + "]");
    }
    const oldStream = streams[name];
    const rows = oldStream ? streams[name].rows : [];
    const stream = {
        info: message.info,
        rows: rows,
        subs: oldStream ? oldStream.subs : 0,
    };
    streams[name] = stream;
    for (let i = rows.length; i < channels.length; ++i) {
        // Add enough rows
        const row = listTable.insertRow();
        const cells = [];
        for (let j = 0; j < 9; ++j) {
            cells.push(row.insertCell());
        }
        cells[6].setAttribute('style', 'white-space: nowrap');
        rows.push({
            row: row,
            cells: cells,
            displayRow: null,
            displayMinutes: null,
            displaySeconds: null,
            displayScale: null,
            cache: {
                lastSample: null,
                zoom: zoom,
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
        rows[i].cells[6].innerHTML = 
            `<button onclick="displayStreamChannel('${name}', ${i})">Display</button> `
            + `<button onclick="zoomStreamChannel('${name}', ${i}, 2.0)">+</button>`
            + `<button onclick="zoomStreamChannel('${name}', ${i}, 0.5)">-</button>`
            + `<button onclick="zoomStreamChannel('${name}', ${i}, 0.0, 1.0)">0</button>`;
        updateScale(name, i);
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

function zoomStreamChannel(name, channel, multiplier, zoom) {
    const stream = streams[name];
    const rows = stream.rows;
    const row = rows[channel];
    const listRow = row.row;
    const cache = row.cache;
    if (zoom) {
        cache.zoom = zoom;
    }
    if (multiplier) {
        cache.zoom *= multiplier;
    }
    updateScale(name, channel);
}

function publishFrame(message) {
    //console.log(message);
    if (!listTable) listTable = document.getElementById("list");
    if (!displayTable) displayTable = document.getElementById("display");
    let name = message.name;
    let stream = streams[name];
    let rows = stream.rows;
    for (let ch = 0; ch < stream.rows.length; ++ch) {
        if (rows[ch].displayRow) {
            const listRow = rows[ch].row;
            const displayMinutes = rows[ch].displayMinutes;
            const displaySeconds = rows[ch].displaySeconds;
            const cache = rows[ch].cache;
            const data = message.channels[ch].data;
            const ctxMin = displayMinutes.getContext("2d");
            const ctxSec = displaySeconds.getContext("2d");
            const width = 768;
            const height = 128;
            const zero = ~~stream.info.zero[ch];
            const sampleScalar = height / Math.pow(2, stream.info.bits);
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
                ctxSec.moveTo(width - data.length - 1, (height / 2) - (cache.lastSample - zero) * sampleScalar * cache.zoom);
            }
            for (let i = 0; i < data.length; ++i) {
                // TODO: Proper scaling etc
                const x = width - data.length + i;
                const y = (height / 2) - (data[i] - zero) * sampleScalar * cache.zoom;
                if (cache.lastSample == null && i == 0) ctxSec.moveTo(x, y);
                else ctxSec.lineTo(x, y);
            }
            ctxSec.stroke();
            cache.lastSample = data[data.length - 1];
            listRow.cells[8].innerHTML = message.timestamp.toString() + ' ' + cache.lastSample + ' ';
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
