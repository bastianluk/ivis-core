'use strict';

const {JobState} = require("../../shared/jobs");
const {getBuiltinTask} = require("./builtin-tasks");

const log = require('../lib/log');
const knex = require('../lib/knex');
const {enforce} = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const jobs = require('./jobs');
const interoperableErrors = require('../../shared/interoperable-errors');
const {isSignalSetAggregationIntervalValid} = require('../../shared/validators');
const moment = require('moment');

async function listDTAjax(context, sigSetId, params) {
    return await dtHelpers.ajaxListWithPermissions(
        context,
        [{entityTypeId: 'job', requiredOperations: ['view']}],
        params,
        builder => builder.from('aggregation_jobs')
            .innerJoin('jobs', function () {
                this.on('aggregation_jobs.job', '=', 'jobs.id').andOn('aggregation_jobs.set', '=', sigSetId);
            })
            .leftJoin('signal_sets_owners', 'signal_sets_owners.job', 'jobs.id')
            .leftJoin('signal_sets', 'signal_sets.id', 'signal_sets_owners.set'),
        ['signal_sets.id', 'signal_sets.cid', 'signal_sets.name', 'signal_sets.description', 'signal_sets.state', 'signal_sets.created', 'jobs.id', 'jobs.params'],
        {
            mapFun: data => {
                data[4] = JSON.parse(data[4]);
                data[7] = JSON.parse(data[7]);
            }
        }
    );
}

async function getMaxFittingAggSet(sigSetId, maxInterval, dateFrom) {
    const sigSet = await knex('aggregation_jobs')
        .select('signal_sets.*')
        .where('aggregation_jobs.set', sigSetId)
        .andWhere('aggregation_jobs.interval', '<=', maxInterval)
        .andWhere(function () {
                this.where('aggregation_jobs.offset', '<=', dateFrom)
                    .orWhereNull('aggregation_jobs.offset')
            }
        )
        .innerJoin('jobs', 'aggregation_jobs.job', 'jobs.id')
        .innerJoin('signal_sets_owners', 'signal_sets_owners.job', 'jobs.id')
        .innerJoin('signal_sets', 'signal_sets.id', 'signal_sets_owners.set')
        .orderBy('interval', 'desc')
        .first();
    if (sigSet) {
        sigSet.settings = JSON.parse(sigSet.settings);

    }
    return sigSet;
}

async function listSetAggs(sigSetId) {
    const setAggs = await knex('aggregation_jobs')
        .where('aggregation_jobs.set', sigSetId)
        .innerJoin('jobs', 'aggregation_jobs.job', 'jobs.id')
        .innerJoin('signal_sets_owners', 'signal_sets_owners.job', 'jobs.id')
        .innerJoin('signal_sets', 'signal_sets.id', 'signal_sets_owners.set');
    setAggs.forEach(parseParams);
    return setAggs;

    function parseParams(record) {
        record.params = JSON.parse(record.params);
    }
}

function intervalStrToMiliseconds(intervalStr) {
    const unit = intervalStr.slice(-1);
    const value = parseInt(intervalStr.slice(0, -1));
    return moment.duration(value, unit).asMilliseconds();
}


async function createTx(tx, context, sigSetId, params) {
    const intervalStr = params.interval;
    const ts = params.ts;

    const signalSet = await tx('signal_sets').where('id', sigSetId).first();
    enforce(signalSet, `Signal set ${sigSetId} not found`);

    const task = await getBuiltinTask('aggregation');
    enforce(task, `Aggregation task not found`);

    const tsExists = tx('signals').where({set: sigSetId, cid: ts}).first();
    enforce(tsExists, `Timestamp signal not found in ${sigSetId}`);

    enforce(isSignalSetAggregationIntervalValid(intervalStr), 'Interval must be a positive integer and have a unit.');

    if (params.offset != null) {
        const date = moment(params.offset, 'YYYY-MM-DD HH:mm:ss', true);
        enforce(date && date.isValid(), 'Offset is not in valid format');
    }

    const jobParams = {
        signalSet: signalSet.cid,
        offset: params.offset,
        ts: ts,
        interval: intervalStr
    };

    const intervalms = intervalStrToMiliseconds(intervalStr);
    const aggregationJobName = `aggregation_${intervalStr}_${signalSet.cid}`;

    const exists = await tx('aggregation_jobs').where('interval', intervalms).first();
    if (exists) {
        throw new interoperableErrors.ServerValidationError(`Aggregation for given interval '${intervalStr}' already exists.`);
    }

    const job = {
        name: aggregationJobName,
        description: `Aggregation for signal set '${signalSet.name}' with bucket interval '${intervalStr}'`,
        namespace: signalSet.namespace,
        task: task.id,
        state: JobState.ENABLED,
        params: jobParams,
        signal_sets_triggers: [sigSetId],
        trigger: null,
        min_gap: null,
        delay: null
    };
    const jobId = await jobs.create(context, job);

    await tx('aggregation_jobs').insert({job: jobId, set: signalSet.id, offset: params.offset, interval: intervalms});

    jobs.run(context, jobId).catch(error => log.error('signal-set-aggregations', error));

    return jobId;
}

async function create(context, sigSetId, params) {
    return await knex.transaction(async tx => {
        return await createTx(tx, context, sigSetId, params);
    });
}

module.exports.create = create;
module.exports.createTx = createTx;
module.exports.listDTAjax = listDTAjax;
module.exports.listSetAggs = listSetAggs;
module.exports.getMaxFittingAggSet = getMaxFittingAggSet;



