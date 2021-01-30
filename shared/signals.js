'use strict';

const moment = require('moment');


const SignalType = {
    INTEGER: 'integer',
    LONG: 'long',
    FLOAT: 'float',
    DOUBLE: 'double',
    BOOLEAN: 'boolean',
    KEYWORD: 'keyword',
    TEXT: 'text',
    DATE_TIME: 'date',
    JSON: 'json',
};

if (Object.freeze) {
    Object.freeze(SignalType);
}

const AllSignalTypes = new Set(Object.values(SignalType));

function isAggregatedType(type) {
    return [SignalType.DOUBLE, SignalType.FLOAT, SignalType.INTEGER, SignalType.LONG].includes(type);
}

/**
 * Naming usage needs to be consistent between aggregation creating job and query processor
 */
function getSigCidForAggSigStat (aggSigCid, stat){
    return `_${aggSigCid}_${stat}`;
}

const SignalSource = {
    RAW: 'raw',
    DERIVED: 'derived',
    JOB: 'job'
};

const AllSignalSources = new Set(Object.values(SignalSource));

if (Object.freeze) {
    Object.freeze(SignalSource);
}

// Maps sources to their allowed types
const typesMap = {
    [SignalSource.DERIVED]: [
        ...AllSignalTypes
    ],
    [SignalSource.RAW]: [
        ...AllSignalTypes
    ],
    [SignalSource.JOB]: [
        ...AllSignalTypes
    ],
};

function getTypesBySource(source) {
    const types = typesMap[source];
    return types ? types : null;
}

const deserializeFromDb = {
    [SignalType.INTEGER]: x => x,
    [SignalType.LONG]: x => x,
    [SignalType.FLOAT]: x => x,
    [SignalType.DOUBLE]: x => x,
    [SignalType.BOOLEAN]: x => x,
    [SignalType.KEYWORD]: x => x,
    [SignalType.TEXT]: x => x,
    [SignalType.DATE_TIME]: x => moment.utc(x).toDate(),
    [SignalType.JSON]: x => JSON.parse(x),
};

const serializeToDb = {
    [SignalType.INTEGER]: x => x,
    [SignalType.LONG]: x => x,
    [SignalType.FLOAT]: x => x,
    [SignalType.DOUBLE]: x => x,
    [SignalType.BOOLEAN]: x => x,
    [SignalType.KEYWORD]: x => x,
    [SignalType.TEXT]: x => x,
    [SignalType.DATE_TIME]: x => moment(x).utc().format('YYYY-MM-DD HH:mm:ss.SSS'),
    [SignalType.JSON]: x => {
        if (typeof x !== "object" || Array.isArray(x)) // arrays and simple types are not indexed properly as 'object' datatype in ES (arrays inside object are fine)
            throw new TypeError("Only JSON objects are allowed.")
        return JSON.stringify(x)
    },
};


const IndexingStatus = {
    READY: 0, // The index is in sync with the data
    REQUIRED: 1, // The index is out of sync with the data
    RUNNING: 2, // The index is currently being created, or indexer crashed during reindex
    SCHEDULED: 3, // The indexer is asked to update the index
};

const IndexMethod = {
    INCREMENTAL: 0,
    FULL: 1
};

module.exports = {
    SignalType,
    AllSignalTypes,
    AllSignalSources,
    getTypesBySource,
    SignalSource,
    IndexingStatus,
    IndexMethod,
    deserializeFromDb,
    serializeToDb,
    isAggregatedType,
    getSigCidForAggSigStat
};
