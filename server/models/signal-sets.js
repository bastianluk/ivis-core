'use strict';

const config = require('../lib/config');
const signalStorage = require('./signal-storage');
const indexer = require('../lib/indexers/' + config.indexer);
const knex = require('../lib/knex');
const hasher = require('node-object-hash')();
const {enforce, filterObject} = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../../shared/interoperable-errors');
const namespaceHelpers = require('../lib/namespace-helpers');
const shares = require('./shares');
const {IndexingStatus, IndexMethod, SignalType, SignalSource, isAggregatedType} = require('../../shared/signals');
const signals = require('./signals');
const {
    SignalSetKind,
    SignalSetType,
    SUBSTITUTE_TS_SIGNAL,
    DEFAULT_TS_SIGNAL_CID,
    DEFAULT_MIN_SUBAGGS_BUCKETS
} = require('../../shared/signal-sets');
const {parseCardinality, getFieldsetPrefix, resolveAbs} = require('../../shared/param-types-helpers');
const log = require('../lib/log');
const synchronized = require('../lib/synchronized');
const moment = require('moment');
const {toQuery, fromQueryResultToDTInput, MAX_RESULTS_WINDOW} = require('../lib/dt-es-query-adapter');
const signalSetAggregations = require('./signal-set-aggregations');

const dependencyHelpers = require('../lib/dependency-helpers');

const allowedKeysCreate = new Set(['cid', 'type', 'name', 'description', 'namespace', 'record_id_template', 'settings', 'kind']);
const allowedKeysUpdate = new Set(['name', 'description', 'namespace', 'record_id_template', 'settings', 'kind']);

const handlebars = require('handlebars');


const recordIdTemplateHandlebars = handlebars.create();
recordIdTemplateHandlebars.registerHelper({
    toISOString: function (val) {
        return moment(val).toISOString();
    },
    padStart: function (val, len) {
        return val.toString().padStart(len, 0);
    }
});

function hash(entity) {
    return hasher.hash(filterObject(entity, allowedKeysUpdate));
}

async function _getBy(context, key, id, withPermissions, withSignalByCidMap) {
    return await knex.transaction(async tx => {
        const entity = await tx('signal_sets').where(key, id).first();

        if (!entity) {
            shares.throwPermissionDenied({sigSetCid: id});
        }

        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', entity.id, 'view');

        entity.settings = JSON.parse(entity.settings);

        if (withPermissions) {
            entity.permissions = await shares.getPermissionsTx(tx, context, 'signalSet', entity.id);
        }

        if (withSignalByCidMap) {
            entity.signalByCidMap = await getSignalByCidMapTx(tx, entity);
        }

        return entity;
    });
}

async function getById(context, id, withPermissions = true, withSignalByCidMap = false) {
    return await _getBy(context, 'id', id, withPermissions, withSignalByCidMap);
}

async function getByCid(context, id, withPermissions = true, withSignalByCidMap = false) {
    return await _getBy(context, 'cid', id, withPermissions, withSignalByCidMap);
}

async function listDTAjax(context, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{entityTypeId: 'signalSet', requiredOperations: ['view']}],
        params,
        builder => builder.from('signal_sets').innerJoin('namespaces', 'namespaces.id', 'signal_sets.namespace'),
        ['signal_sets.id', 'signal_sets.cid', 'signal_sets.name', 'signal_sets.description', 'signal_sets.type', 'signal_sets.state', 'signal_sets.created', 'signal_sets.settings', 'namespaces.name'],
        {
            mapFun: data => {
                data[5] = JSON.parse(data[5]);
            }
        }
    );
}

async function listRecordsDTAjax(context, sigSetId, params) {
    return await knex.transaction(async tx => {
        // shares.enforceEntityPermissionTx(tx, context, 'signalSet', sigSetId, 'query') is already called inside signals.listVisibleForListTx
        const sigs = await signals.listVisibleForListTx(tx, context, sigSetId);

        //TODO check for case when list of visibles changes between calls

        const sigSet = await tx('signal_sets').where('id', sigSetId).first();

        if (sigSet.type !== SignalSetType.COMPUTED) {
            return await signalStorage.listRecordsDTAjaxTx(
                tx,
                sigSet,
                sigs.filter(sig => sig.source === SignalSource.RAW).map(sig => sig.id),
                params
            );
        } else {
            return await listRecordsESAjax(tx, context, sigSet, params, sigs);
        }
    });
}

async function listRecordsESAjax(tx, context, sigSet, params, signals) {
    // Elasticsearch is a distributed system therefore deep pagination gets very costly
    enforce(params.length + params.start < MAX_RESULTS_WINDOW, `Pagination over ${MAX_RESULTS_WINDOW} not supported.`);
    return await fromQueryResultToDTInput(
        await queryTx(tx, context, [
            toQuery(sigSet, signals, params)
        ]),
        sigSet,
        signals,
        params
    );
}

async function list() {
    return await knex('signal_sets');
}

async function serverValidate(context, data) {
    const result = {};

    if (data.cid) {
        await shares.enforceTypePermission(context, 'namespace', 'createSignalSet');

        const query = knex('signal_sets').where('cid', data.cid);

        if (data.id) {
            // Id is not set in entity creation form
            query.andWhereNot('id', data.id);
        }

        const signalSet = await query.first();

        result.cid = {};
        result.cid.exists = !!signalSet;
    }

    return result;
}

async function _validateAndPreprocess(tx, entity, isCreate) {
    await namespaceHelpers.validateEntity(tx, entity);

    const existingWithCidQuery = tx('signal_sets').where('cid', entity.cid);
    if (!isCreate) {
        existingWithCidQuery.whereNot('id', entity.id);
    }

    const existingWithCid = await existingWithCidQuery.first();
    enforce(!existingWithCid, `Signal set's machine name (cid) '${entity.cid}' is already used for another signal set.`)

}


async function createTx(tx, context, entity) {
    shares.enforceGlobalPermission(context, 'allocateSignalSet');
    await shares.enforceEntityPermissionTx(tx, context, 'namespace', entity.namespace, 'createSignalSet');

    await _validateAndPreprocess(tx, entity, true);

    const filteredEntity = filterObject(entity, allowedKeysCreate);

    filteredEntity.state = JSON.stringify({
        indexing: {
            status: IndexingStatus.READY
        }
    });

    if (entity.type) {
        enforce(!(entity.type in Object.values(SignalSetType)), `${entity.type} is not valid signal set type.`)
    }

    filteredEntity.settings = JSON.stringify({...filteredEntity.settings});
    const ids = await tx('signal_sets').insert(filteredEntity);
    const id = ids[0];

    entity.id = id;
    if (!entity.type || entity.type !== SignalSetType.COMPUTED) {
        await signalStorage.createStorage(entity);
    } else {
        await indexer.onCreateStorage(entity);
    }

    await shares.rebuildPermissionsTx(tx, {entityTypeId: 'signalSet', entityId: id});

    if (filteredEntity.kind === SignalSetKind.TIME_SERIES) {
        await signals.createTx(tx, context, id, {
            cid: 'ts',
            name: 'Timestamp',
            description: 'Timestamp of data measurements',
            namespace: entity.namespace,
            type: SignalType.DATE_TIME,
            set: id,
            source: SignalSource.RAW
        });
    }

    return id;
}

async function create(context, entity) {
    return await knex.transaction(async tx => {
        return await createTx(tx, context, entity);
    });
}

async function updateWithConsistencyCheck(context, entity) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', entity.id, 'edit');

        const existing = await tx('signal_sets').where('id', entity.id).first();
        if (!existing) {
            throw new interoperableErrors.NotFoundError();
        }

        existing.settings = JSON.parse(existing.settings);
        const existingHash = hash(existing);
        if (existingHash !== entity.originalHash) {
            throw new interoperableErrors.ChangedError();
        }

        if (entity.kind) {
            enforce(Object.values(SignalSetKind).includes(entity.kind), `'${entity.kind}' is not valid kind of signal set`);
            if (entity.kind === SignalSetKind.TIME_SERIES) {
                enforce(entity.settings.ts, 'Time series need timestamp signal to be specified.')
            }
        }

        await _validateAndPreprocess(tx, entity, false);

        await namespaceHelpers.validateMove(context, entity, existing, 'signalSet', 'createSignalSet', 'delete');

        const filteredEntity = filterObject(entity, allowedKeysUpdate);
        filteredEntity.settings = JSON.stringify(filteredEntity.settings);
        await tx('signal_sets').where('id', entity.id).update(filteredEntity);

        await shares.rebuildPermissionsTx(tx, {entityTypeId: 'signalSet', entityId: entity.id});
    });
}

async function _remove(context, key, id) {
    await knex.transaction(async tx => {
        const existing = await tx('signal_sets').where(key, id).first();

        if (!existing) {
            shares.throwPermissionDenied();
        }

        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', existing.id, 'delete');

        // TODO cant use ensure dependecies here as job doesn't have foreign key to signal-sets, but this
        // probably should be handled better, as there may be other extensions
        const exists = await tx('aggregation_jobs').where('set', existing.id).first();
        enforce(!exists, `Signal set has aggregation ${exists ? exists.id : ''} delete it first.`);

        await tx('signals').where('set', existing.id).del();
        await tx('signal_sets').where('id', existing.id).del();

        if (existing.type !== SignalSetType.COMPUTED) {
            await signalStorage.removeStorage(existing);
        } else {
            return await indexer.onRemoveStorage(existing);
        }
    });
}

async function removeById(context, id) {
    return await _remove(context, 'id', id);
}

async function removeByCid(context, cid) {
    return await _remove(context, 'cid', cid);
}

// Thought this method modifies the storage schema, it can be called concurrently from async. This is meant to simplify coding of intake endpoints.
async function _ensure(context, signalSetConfig, schema) {
    const {
        cid,
        name,
        description,
        namespace,
        kind = SignalSetKind.GENERIC,
        settings = {}
    } = signalSetConfig;

    return await knex.transaction(async tx => {
        let signalSet = await tx('signal_sets').where('cid', cid).first();
        if (!signalSet) {
            signalSet = {
                cid,
                name,
                description,
                namespace,
                kind,
                settings
            };

            const id = await createTx(tx, context, signalSet);
            signalSet.id = id;
        }

        const signalByCidMap = {};
        signalSet.signalByCidMap = signalByCidMap;

        const existingSignals = await tx('signals').where('set', signalSet.id);

        const existingSignalTypes = {};
        for (const row of existingSignals) {
            existingSignalTypes[row.cid] = row.type;
            signalByCidMap[row.cid] = row;
        }

        const fieldAdditions = {};
        let schemaExtendNeeded = false;

        for (const fieldCid in schema) {
            let fieldSpec;

            if (typeof schema[fieldCid] === 'string') {
                fieldSpec = {
                    name: fieldCid,
                    type: schema[fieldCid],
                    settings: {},
                    indexed: true
                }
            } else {
                fieldSpec = schema[fieldCid];
            }

            const existingSignalType = existingSignalTypes[fieldCid];

            if (existingSignalType) {
                enforce(existingSignalType === fieldSpec.type, `Signal "${fieldCid}" is already present with another type.`);

            } else {
                await shares.enforceEntityPermissionTx(tx, context, 'namespace', namespace, 'createSignal');
                await shares.enforceEntityPermissionTx(tx, context, 'signalSet', signalSet.id, 'createSignal');

                const signal = {
                    cid: fieldCid,
                    ...fieldSpec,
                    set: signalSet.id,
                    namespace: namespace
                };

                signal.settings = JSON.stringify(signal.settings);

                const signalIds = await tx('signals').insert(signal);
                const signalId = signalIds[0];
                signal.id = signalId;

                await shares.rebuildPermissionsTx(tx, {entityTypeId: 'signal', entityId: signalId});

                fieldAdditions[signalId] = fieldSpec.type;
                existingSignalTypes[fieldCid] = fieldSpec.type;
                schemaExtendNeeded = true;

                signalByCidMap[fieldCid] = signal;
            }
        }

        if (schemaExtendNeeded) {
            await signalStorage.extendSchema(signalSet, fieldAdditions);
        }

        return signalSet;
    });
}

const ensure = synchronized(_ensure);


async function getSignalByCidMapTx(tx, sigSet) {
    const sigs = await tx('signals').where('set', sigSet.id);

    const mapping = {};
    for (const sig of sigs) {
        mapping[sig.cid] = sig;
    }

    return mapping;
}

function getRecordIdTemplate(sigSet) {
    const recordIdTemplateSource = sigSet.record_id_template;
    if (recordIdTemplateSource) {
        return recordIdTemplateHandlebars.compile(recordIdTemplateSource, {noEscape: true});
    } else {
        return null;
    }
}

async function getRecord(context, sigSetWithSigMap, recordId) {
    const sigs = await signals.listVisibleForEdit(context, sigSetWithSigMap.id, true);
    const record = await signalStorage.getRecord(sigSetWithSigMap, recordId);

    const filteredSignals = {};

    for (const sig of sigs) {
        filteredSignals[sig.cid] = record.signals[sig.cid];
    }

    return {
        id: record.id,
        signals: filteredSignals
    };
}

async function insertRecords(context, sigSetWithSigMap, records) {
    await shares.enforceEntityPermission(context, 'signalSet', sigSetWithSigMap.id, 'insertRecord');
    await signalStorage.insertRecords(sigSetWithSigMap, records);
}

async function updateRecord(context, sigSetWithSigMap, existingRecordId, record) {
    await shares.enforceEntityPermission(context, 'signalSet', sigSetWithSigMap.id, 'editRecord');
    await signalStorage.updateRecord(sigSetWithSigMap, existingRecordId, record);
}

async function removeRecord(context, sigSet, recordId) {
    await shares.enforceEntityPermission(context, 'signalSet', sigSet.id, 'deleteRecord');
    await signalStorage.removeRecord(sigSet, recordId);
}


async function serverValidateRecord(context, sigSetId, data) {
    const result = {};

    await shares.enforceEntityPermission(context, 'signalSet', sigSetId, ['insertRecord', 'editRecord']);
    const sigSetWithSigMap = await getById(context, sigSetId, false, true);

    result.id = {};

    if (sigSetWithSigMap.record_id_template) {
        const recordIdTemplate = getRecordIdTemplate(sigSetWithSigMap);

        const recordId = recordIdTemplate(data.signals);

        result.id.exists = await signalStorage.idExists(sigSetWithSigMap, recordId, data.existingId);

    } else if (data.id) {
        result.id.exists = await signalStorage.idExists(sigSetWithSigMap, data.id, data.existingId);
    }

    return result;
}


async function getLastId(context, sigSet) {
    await shares.enforceEntityPermission(context, 'signalSet', sigSet.id, 'query');

    const lastId = await signalStorage.getLastId(sigSet);
    return lastId;
}

/* queries = [
    {
        params: {
            withId: <true returns also _id field>
        },
        sigSetCid: <sigSetCid>,

        substitutionOpts: {
            allow: <false forbids usage of aggregation sets>,
            minSubaggsBuckets: <minimum of an aggregation set intervals per bucket>
        },

        signals: [<sigCid>, ...],

        filter: {
            type: "and",
            children: [
                {
                    type: "range",
                    sigCid: <sigCid>,
                    lte / lt: <value or date>,
                    gte / gt: <value or date>
                },
                {
                    type: "mustExist",
                    sigCid: <sigCid>
                }
            ]
        },

        aggs: [
            {
                sigCid: <sigCid>,
                buckets: [{gte/gt, lte/lt}] / step: <value or time interval>, offset: <offset in ms>
                signals: [sigCid: ['min', 'max', 'avg']] / aggs,
                order: 'asc'/'desc',
                limit: <max no. of records>
            }
        ]

        <OR>

        sample: { // TODO: Not implemented yet
            limit: <max no. of records>,
            sort: [
                {
                    sigCid: 'ts',
                    order: 'asc'
                }
            ]
        }

        <OR>

        docs: { // TODO: Not implemented yet
            limit: <max no. of records>,
            sort: [
                {
                    sigCid: <sigCid> <OR> field: <allowed field>,
                    order: 'asc'/'desc'
                }
            ]
        }

        <OR>

        summary: {
            signals: [sigCid: ['min', 'max', 'avg']]
        ]
    }

*/
async function query(context, queries) {
    return await knex.transaction(async tx => {
        return await queryTx(tx, context, queries);
    });
}

async function queryTx(tx, context, queries) {
    for (const sigSetQry of queries) {
        const sigSet = await tx('signal_sets').where('cid', sigSetQry.sigSetCid).first();
        if (!sigSet) {
            shares.throwPermissionDenied({sigSetCid: sigSetQry.sigSetCid});
        }
        sigSet.settings = JSON.parse(sigSet.settings);

        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', sigSet.id, 'query');

        let substitutionOpts = setupSubstitutionOpts(sigSetQry.substitutionOpts);

        // Map from signal cid to signal
        const signalMap = {};

        const sigs = await tx('signals').where('set', sigSet.id);
        for (const sig of sigs) {
            sig.settings = JSON.parse(sig.settings);
            signalMap[sig.cid] = sig;
        }

        const signalsToCheck = new Set();

        function mutateSignalCid(sigCid) {
            if (sigCid === SUBSTITUTE_TS_SIGNAL) {
                return sigSet.kind === SignalSetKind.TIME_SERIES ? sigSet.settings.ts : DEFAULT_TS_SIGNAL_CID;
            }
            return sigCid;
        }

        const checkFilter = flt => {
            if (flt.type === 'and' || flt.type === 'or') {
                for (const fltChild of flt.children) {
                    checkFilter(fltChild);
                }
            } else if (flt.type === 'range' || flt.type === 'mustExist' || flt.type === 'wildcard' || flt.type === 'terms') {
                flt.sigCid = mutateSignalCid(flt.sigCid);
                const sig = signalMap[flt.sigCid];
                if (!sig) {
                    shares.throwPermissionDenied({sigCid: flt.sigCid});
                }
                signalsToCheck.add(sig.id);
            } else if (flt.type === 'ids') {
                // empty
            } else if (flt.type === 'function_score') {
                if (!flt.function)
                    throw new Error('Function not specified for function_score query');
            } else {
                throw new Error(`Unknown filter type "${flt.type}"`);
            }
        };

        if (sigSetQry.filter) {
            checkFilter(sigSetQry.filter)
        }

        const checkSignals = signals => {
            for (const [i, sigCid] of signals.entries()) {
                signals[i] = mutateSignalCid(sigCid);
                const sig = signalMap[signals[i]];
                if (!sig) {
                    log.verbose(`unknown signal ${sigSet.cid}.${signals[i]}`);
                    shares.throwPermissionDenied({sigCid: signals[i]});
                }

                // Can't mix aggregated types with non
                if (!isAggregatedType(sig.type)) {
                    substitutionOpts = null;
                }

                signalsToCheck.add(sig.id);
            }
        };

        const checkAggs = aggs => {
            for (const agg of aggs) {
                agg.sigCid = mutateSignalCid(agg.sigCid);
                const sig = signalMap[agg.sigCid];
                if (!sig) {
                    shares.throwPermissionDenied({sigCid: agg.sigCid});
                }

                signalsToCheck.add(sig.id);
                if (agg.signals) {
                    checkSignals(Object.keys(agg.signals));
                } else if (agg.aggs) {
                    checkAggs(agg.aggs);
                }

                // Find lowest step for aggregation selection
                if (substitutionOpts) {
                    let aggStep = moment.duration(agg.step).asMilliseconds();
                    if (!substitutionOpts.minStep || aggStep < substitutionOpts.minStep) {
                        substitutionOpts.minStep = aggStep;
                    }
                }
            }
        };

        const checkSort = sort => {
            if (sort) {
                for (const srt of sort) {
                    // Ignores other types of sorts
                    if (srt.sigCid) {
                        srt.sigCid = mutateSignalCid(srt.sigCid);
                        const sig = signalMap[srt.sigCid];
                        if (!sig) {
                            shares.throwPermissionDenied({sigCid: srt.sigCid});
                        }

                        signalsToCheck.add(sig.id);
                    }
                }
            }
        };

        if (sigSetQry.aggs) {
            checkAggs(sigSetQry.aggs);
        } else if (sigSetQry.docs) {
            checkSignals(sigSetQry.docs.signals);
            checkSort(sigSetQry.docs.sort);
        } else if (sigSetQry.sample) {
            checkSignals(sigSetQry.sample.signals);
            checkSort(sigSetQry.sample.sort);
        } else if (sigSetQry.summary) {
            checkSignals(Object.keys(sigSetQry.summary.signals));
        } else {
            throw new Error('None of "aggs", "docs", "sample", "summary" query part has been specified');
        }

        for (const sigId of signalsToCheck) {
            await shares.enforceEntityPermissionTx(tx, context, 'signal', sigId, 'query');
        }

        if (substitutionOpts && substitutionOpts.minStep) {
            const maxInterval = substitutionOpts.minStep / substitutionOpts.minSubaggsBuckets;
            if (sigSetQry.filter && sigSetQry.filter.gte) {
                substitutionOpts.dateFrom = sigSetQry.filter.gte;
            }
            const aggSigSet = await signalSetAggregations.getMaxFittingAggSet(sigSet.id, maxInterval, substitutionOpts.dateFrom);
            if (aggSigSet) {
                sigSetQry.aggSigSet = {
                    sigSet: aggSigSet,
                    signalMap: {}
                };
                const sigs = await tx('signals').where('set', aggSigSet.id);
                for (const sig of sigs) {
                    sig.settings = JSON.parse(sig.settings);
                    sigSetQry.aggSigSet.signalMap[sig.cid] = sig;
                }
            }
        }

        sigSetQry.sigSet = sigSet;
        sigSetQry.signalMap = signalMap;
    }

    const resp = await indexer.query(queries);
    return resp;
}

function setupSubstitutionOpts(querySubstitutionOpts) {
    let substitutionOpts = {
        minSubaggsBuckets: DEFAULT_MIN_SUBAGGS_BUCKETS,
        ...querySubstitutionOpts
    };

    if (substitutionOpts.allow !== false) {
        return substitutionOpts;
    } else {
        return null;
    }
}

async function index(context, signalSetId, method = IndexMethod.FULL, from) {
    let existing;

    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'signalSet', signalSetId, 'reindex');
        existing = await tx('signal_sets').where('id', signalSetId).first();

        const state = JSON.parse(existing.state);
        state.indexing.status = IndexingStatus.SCHEDULED;
        await tx('signal_sets').where('id', signalSetId).update('state', JSON.stringify(state));
    });

    return await indexer.index(existing, method, from);
}

async function getAllowedSignals(templateParams, params) {

    const allowedSigSets = new Map();
    const sigSetsPathMap = new Map();

    function computeSetsPathMap(templateParams, params, prefix = '/') {
        for (const spec of templateParams) {
            if (spec.type === 'signalSet') {
                sigSetsPathMap.set(resolveAbs(prefix, spec.id), params[spec.id]);
                allowedSigSets.set(params[spec.id], new Set());

            } else if (spec.type === 'fieldset') {
                const card = parseCardinality(spec.cardinality);
                if (spec.children) {
                    if (card.max === 1) {
                        computeSetsPathMap(spec.children, params[spec.id], getFieldsetPrefix(prefix, spec));
                    } else {
                        let entryIdx = 0;
                        for (const childParams of params[spec.id]) {
                            computeSetsPathMap(spec.children, childParams, getFieldsetPrefix(prefix, spec, entryIdx));
                            entryIdx += 1;
                        }
                    }
                }
            }
        }
    }

    function computeAllowedSignals(templateParams, params, prefix = '/') {
        for (const spec of templateParams) {
            if (spec.type === 'signal') {
                if (spec.signalSetRef) {
                    const sigCid = params[spec.id]; // If a parameter is not selected (e.g. because the config has not been updated after params change), this is empty
                    if (sigCid) {
                        const sigSetCid = sigSetsPathMap.get(resolveAbs(prefix, spec.signalSetRef));

                        let sigSet = allowedSigSets.get(sigSetCid);
                        if (!sigSet) {
                            sigSet = new Set();
                            allowedSigSets.set(sigSetCid, sigSet);
                        }

                        const card = parseCardinality(spec.cardinality);
                        if (card.max === 1) {
                            sigSet.add(sigCid);
                        } else {
                            for (const entry of sigCid) {
                                sigSet.add(entry);
                            }
                        }
                    }
                }
            } else if (spec.type === 'fieldset') {
                const card = parseCardinality(spec.cardinality);
                if (spec.children) {
                    if (card.max === 1) {
                        computeAllowedSignals(spec.children, params[spec.id], getFieldsetPrefix(prefix, spec));
                    } else {
                        let entryIdx = 0;
                        for (const childParams of params[spec.id]) {
                            computeAllowedSignals(spec.children, childParams, getFieldsetPrefix(prefix, spec, entryIdx));
                            entryIdx += 1;
                        }
                    }
                }
            }
        }
    }

    computeSetsPathMap(templateParams, params);
    computeAllowedSignals(templateParams, params);

    if (allowedSigSets.size > 0) {
        const query = knex('signal_sets').innerJoin('signals', 'signal_sets.id', 'signals.set').select(['signal_sets.cid AS setCid', 'signal_sets.id as setId', 'signals.cid AS signalCid', 'signals.id AS signalId']);

        for (const [key, sigs] of allowedSigSets.entries()) {
            const whereFun = function () {
                this.where('signal_sets.cid', key).whereIn('signals.cid', [...sigs.values()]);
            };

            query.orWhere(whereFun);
        }

        const rows = await query;

        const result = new Map();
        for (const row of rows) {
            if (!result.has(row.setCid)) {
                result.set(row.setCid, {
                    id: row.setId,
                    sigs: new Map()
                });
            }

            const sigMap = result.get(row.setCid).sigs;
            if (!sigMap.has(row.signalCid)) {
                sigMap.set(row.signalCid, row.signalId);
            }
        }

        return result;

    } else {
        return new Map();
    }
}


module.exports.hash = hash;
module.exports.getById = getById;
module.exports.getByCid = getByCid;
module.exports.listDTAjax = listDTAjax;
module.exports.list = list;
module.exports.create = create;
module.exports.createTx = createTx;
module.exports.updateWithConsistencyCheck = updateWithConsistencyCheck;
module.exports.removeById = removeById;
module.exports.removeByCid = removeByCid;
module.exports.serverValidate = serverValidate;
module.exports.ensure = ensure;
module.exports.getRecord = getRecord;
module.exports.insertRecords = insertRecords;
module.exports.updateRecord = updateRecord;
module.exports.removeRecord = removeRecord;
module.exports.serverValidateRecord = serverValidateRecord;
module.exports.index = index;
module.exports.query = query;
module.exports.getAllowedSignals = getAllowedSignals;
module.exports.getLastId = getLastId;
module.exports.getSignalByCidMapTx = getSignalByCidMapTx;
module.exports.getRecordIdTemplate = getRecordIdTemplate;
module.exports.listRecordsDTAjax = listRecordsDTAjax;
