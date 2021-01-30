'use strict';

const events = require('events');

const emitter = new events.EventEmitter();
const EventTypes = {
    INSERT: 'insert', // Records were inserted
    INDEX: 'index', // Index or reindex occurred
    UPDATE: 'update', // Records were updated
    REMOVE: 'remove' // Records were removed
}

module.exports = {
    EventTypes,
    emitter
}
