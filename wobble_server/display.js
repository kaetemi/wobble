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
// https://javascript.info/websocket
// https://www.w3schools.com/jsref/met_table_insertrow.asp
// https://www.w3schools.com/html/html5_canvas.asp
// https://www.w3schools.com/tags/ref_canvas.asp

const wobbleProtocolDescriptor = require("./wobble_protocol.json");
const wobbleProtocol = protobuf.Root.fromJSON(wobbleProtocolDescriptor);

const MessageType = wobbleProtocol.MessageType;
const Unit = wobbleProtocol.Unit;
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

function queryCache(name) {
    let message = {
        messageType: MessageType.QUERY_CACHE,
        name: name
    };
    let buffer = QueryCache.encode(message).finish();
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
    console.log(row);
    const scaleCanvas = row.displayScale;
    const scaleCell = listRow.cells[7];
    const cache = row.cache;
    const zoom = cache.zoom;
    const scale = stream.info.scale / zoom;

    const unit = units[stream.info.unit];
    const scaleText = "±" + scale + unit;
    listRow.cells[7].innerHTML = scaleText;

    const width = scaleCanvas.width;
    const height = scaleCanvas.height;
    const unitsToPixels = height * 0.5 * cache.zoom / stream.info.scale;

    const ctx = scaleCanvas.getContext("2d");
    const bgHeight = stream.info.scale * unitsToPixels * 2.0;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, (height - bgHeight) * 0.5, width, bgHeight);

    ctx.font = '11px serif';
    if (stream.info.unit == Unit.G) {
        // Draw quake scale
        let scales = [
            { value: 1.24, label: "IX" },
            { value: 0.65, label: "VIII" },
            { value: 0.34, label: "VII" },
            { value: 0.18, label: "VI" },
            { value: 0.092, label: "V" },
            { value: 0.039, label: "IV" },
            { value: 0.014, label: "II-III" },
            // { value: 0.005, label: "II" }, // Verify this one!
            { value: 0.0017, label: "I" },
        ];
        ctx.fillStyle = 'rgba(0, 0, 0, 0.125)';
        for (let i = 0; i < scales.length; ++i) {
            const h = scales[i].value * unitsToPixels * 2.0;
            ctx.fillRect(0, (height - h) * 0.5, width, h);
        }
        ctx.fillStyle = '#FFFFFF';
        for (let i = 0; i < scales.length; ++i) {
            const h = scales[i].value * unitsToPixels * 2.0;
            ctx.fillText(scales[i].label, 0, (height - h) * 0.5,); 
        }
    }
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
            + `<button onclick="zoomStreamChannel('${name}', ${i}, 0.0, 1.0)">0</button>`
            + ((i == 0) ? ` <button onclick="replotStream('${name}')">Replot</button> ` : '');
        if (rows[i].displayScale) {
            updateScale(name, i);
        }
    }
    // Resub
    if (oldStream && oldStream.resub) {
        subscribe(name);
    }
}

function displayStreamChannel(name, channel) {
    if (!displayTable) displayTable = document.getElementById("display");
    const stream = streams[name];
    const row = stream.rows[channel];
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

        const minutesCell = row.displayRow.insertCell();
        minutesCell.setAttribute('bgcolor', '#E0E0E0');
        const minutesCanvas = document.createElement("canvas");
        minutesCanvas.setAttribute('width', 768);
        minutesCanvas.setAttribute('height', 128);
        minutesCell.appendChild(minutesCanvas);
        row.displayMinutes = minutesCanvas;

        const secondsCell = row.displayRow.insertCell();
        secondsCell.setAttribute('bgcolor', '#E0E0E0');
        const secondsCanvas = document.createElement("canvas");
        secondsCanvas.setAttribute('width', 768);
        secondsCanvas.setAttribute('height', 128);
        secondsCell.appendChild(secondsCanvas);
        row.displaySeconds = secondsCanvas;

        const scaleCell = row.displayRow.insertCell();
        scaleCell.setAttribute('bgcolor', '#E0E0E0');
        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.setAttribute('width', 32);
        scaleCanvas.setAttribute('height', 128);
        scaleCell.appendChild(scaleCanvas);
        row.displayScale = scaleCanvas;

        // Prepare storage
        const cache = row.cache;
        // cache.collector = [ ];
        cache.lastSample = null;
        cache.lastTimestamp = null;

        // Subscribe
        if (!stream.subs) {
            subscribe(name);
        }
        ++stream.subs;
        updateScale(name, channel);
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
} zoomStreamChannel;

function replotStream(name) {
    const stream = streams[name];
    const rows = stream.rows;
    for (let ch = 0; ch < stream.rows.length; ++ch) {
        if (rows[ch].displayRow) {
            const displayMinutes = rows[ch].displayMinutes;
            const ctxMin = displayMinutes.getContext("2d");
            ctxMin.fillStyle = '#F0F0F0';
            ctxMin.fillRect(0, 0, displayMinutes.width, displayMinutes.height);
        }
    }
    queryCache(name);
} replotStream;

// Live frame
function publishFrame(message) {
    // console.log(message);
    const name = message.name;
    const stream = streams[name];
    const rows = stream.rows;
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
            const factor = sampleScalar * cache.zoom;
            if (cache.displayedSamples) {
                // Shift image left by new samples
                ctxSec.drawImage(displaySeconds, -data.length, 0);
                cache.displayedSamples += data.length;
            } else {
                cache.displayedSamples = data.length;
            }
            ctxSec.fillStyle = '#FFFFFF';
            ctxSec.fillRect(width - data.length, 0, data.length, height);
            ctxSec.beginPath();
            if (cache.lastSample != null) {
                ctxSec.moveTo(width - data.length - 1, (height / 2) - (cache.lastSample - zero) * factor);
            }
            for (let i = 0; i < data.length; ++i) {
                const x = width - data.length + i;
                const y = (height / 2) - (data[i] - zero) * factor;
                if (cache.lastSample == null && i == 0) ctxSec.moveTo(x, y);
                else ctxSec.lineTo(x, y);
            }
            ctxSec.stroke();
            cache.lastSample = data[data.length - 1];
            listRow.cells[8].innerHTML = message.timestamp.toString() + ' ' + cache.lastSample + ' ';

            const timestamp = parseFloat(message.timestamp.toString());
            if (!cache.lastTimestamp) {
                cache.lastTimestamp = timestamp - (timestamp % 500000) - 500000; // Half a second per pixel
                console.log(cache.lastTimestamp);
            }
            const usPerSample = 1000000.0 / stream.info.frequency;
            const samplesPerPixel = stream.info.frequency / 2.0;
            const pixelFill = `rgba(0, 0, 0, ${Math.min(1.0, 64.0 / samplesPerPixel)})`;
            ctxMin.fillStyle = pixelFill;
            for (let i = 0; i < data.length; ++i) {
                const ts = timestamp + (i * usPerSample);
                const tsr = ~~((ts - cache.lastTimestamp) / 500000);
                if (tsr > 0) {
                    // Shift image by one pixel
                    ctxMin.drawImage(displayMinutes, -tsr, 0);
                    ctxMin.fillStyle = '#FFFFFF';
                    ctxMin.fillRect(width - tsr, 0, tsr, height);
                    ctxMin.fillStyle = pixelFill;
                    cache.lastTimestamp = (cache.lastTimestamp + (500000 * tsr));
                }
                const y = (height / 2) - (data[i] - zero) * factor;
                ctxMin.fillRect(width - 1, y, 1, 1);
            }
        }
    }
}

// Frame from replot query
function resultFrame(message) {
    // console.log(message);
    const name = message.name;
    const stream = streams[name];
    const rows = stream.rows;
    for (let ch = 0; ch < stream.rows.length; ++ch) {
        if (rows[ch].displayRow) {
            const cache = rows[ch].cache;
            const displayMinutes = rows[ch].displayMinutes;
            const data = message.channels[ch].data;
            const ctxMin = displayMinutes.getContext("2d");
            const zero = ~~stream.info.zero[ch];
            const width = 768;
            const height = 128;
            const sampleScalar = height / Math.pow(2, stream.info.bits);
            const factor = sampleScalar * cache.zoom;

            const timestamp = parseFloat(message.timestamp.toString());
            if (!cache.lastTimestamp) {
                // cache.lastTimestamp = timestamp - (timestamp % 500000) + ((width - 1) * 500000); // Half a second per pixel
                cache.lastTimestamp = timestamp - (timestamp % 500000) - 500000; // Half a second per pixel
                console.log(cache.lastTimestamp);
            }
            const usPerSample = 1000000.0 / stream.info.frequency;
            const samplesPerPixel = stream.info.frequency / 2.0;
            const pixelFill = `rgba(0, 0, 0, ${Math.min(1.0, 64.0 / samplesPerPixel)})`;
            ctxMin.fillStyle = pixelFill;
            for (let i = 0; i < data.length; ++i) {
                const ts = timestamp + (i * usPerSample);
                let tsr = ~~((ts - cache.lastTimestamp) / 500000);
                if (tsr > 0) {
                    // Shift image by one pixel
                    ctxMin.drawImage(displayMinutes, -tsr, 0);
                    ctxMin.fillStyle = '#F0F0F0';
                    ctxMin.fillRect(width - tsr, 0, tsr, height);
                    ctxMin.fillStyle = pixelFill;
                    cache.lastTimestamp = (cache.lastTimestamp + (500000 * tsr));
                }
                tsr = ~~((ts - cache.lastTimestamp) / 500000);
                const x = width + tsr - 1;
                const y = (height / 2) - (data[i] - zero) * factor;
                ctxMin.fillRect(x, y, 1, 1);
            }
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
            case MessageType.RESULT_FRAME: {
                let message = PublishFrame.decode(buffer);
                // console.log(message);
                resultFrame(message);
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
