'use strict';

const elasticsearch = require('../elasticsearch');
const {SignalSource, getTypesBySource, SignalType} = require('../../../shared/signals');

const  COPY_ID_PIPELINE = 'copy-id';

// Gets the name of an index for a signal set
function getIndexName(sigSet) {
    return 'signal_set_' + sigSet.id;
}

const getFieldName = (fieldId) => 's' + fieldId;

const fieldTypes = {
    [SignalType.INTEGER]: 'integer',
    [SignalType.LONG]: 'long',
    [SignalType.FLOAT]: 'float',
    [SignalType.DOUBLE]: 'double',
    [SignalType.BOOLEAN]: 'boolean',
    [SignalType.KEYWORD]: 'keyword',
    [SignalType.TEXT]: 'text',
    [SignalType.DATE_TIME]: 'date',
    [SignalType.JSON]: 'object',
};

async function createIndex(sigSet, signalByCidMap) {
    const indexName = getIndexName(sigSet);

    const properties = {};
    for (const fieldCid in signalByCidMap) {
        const field = signalByCidMap[fieldCid];
        if (field.source === SignalSource.RAW || field.source === SignalSource.JOB) {
            properties[getFieldName(field.id)] = {type: fieldTypes[field.type]};
        }
    }

    properties['id'] = {
        type: fieldTypes[SignalType.KEYWORD]
    };

    await elasticsearch.indices.create({
        index: indexName,
        body: {
            mappings: {
                _doc: {
                    properties
                }
            },
            settings: {
                    default_pipeline: COPY_ID_PIPELINE
            }
        }
    });
}

async function extendMapping(sigSet, fields) {
    const indexName = getIndexName(sigSet);

    const properties = {};
    for (const fieldId in fields) {
        const fieldType = fields[fieldId];
        if (fieldTypes[fieldType] != null) {
            properties[getFieldName(fieldId)] = {type: fieldTypes[fieldType]};
        }
    }

    await elasticsearch.indices.putMapping({
        index: indexName,
        type: '_doc',
        body: {
            properties
        }
    });
}

module.exports = {
    getIndexName,
    getFieldName,
    createIndex,
    extendMapping,
    COPY_ID_PIPELINE
};
