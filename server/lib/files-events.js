'use strict';

const events = require('events');

const emitter = new events.EventEmitter();
const EventTypes = {
    CHANGE: 'files-change',
    REMOVE:'files-remove' ,
    REMOVE_ALL:'files-remove-all'
}

module.exports = {
    EventTypes,
    emitter
}
