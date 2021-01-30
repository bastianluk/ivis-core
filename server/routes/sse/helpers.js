'use strict';

function initEventSource(res) {
    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    res.write('retry: 5000\n\n');
    res.flush();
}

function sendEvent(res, eventType, data) {
    res.write(`event: ${eventType}\n`);
    if (data != null) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } else {
        res.write(`\n`);
    }
    res.flush();
}

module.exports = {
    initEventSource,
    sendEvent
}