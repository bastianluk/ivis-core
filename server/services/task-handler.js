'use strict';

const config = require('../lib/config');
const knex = require('../lib/knex');
const em = require('../lib/extension-manager');

const {JobState, RunStatus, HandlerMsgType, JobMsgType} = require('../../shared/jobs');
const {TaskType, BuildState, isTransitionState} = require('../../shared/tasks');
const {SignalSetType} = require('../../shared/signal-sets');
const {SignalSource} = require('../../shared/signals');
const log = require('../lib/log');
const {getFieldName, getIndexName} = require('../lib/indexers/elasticsearch-common');
const moment = require('moment');
const getTaskBuildOutputDir = require('../lib/task-handler').getTaskBuildOutputDir;
const {getAdminContext} = require('../lib/context-helpers');
const createSigSet = require('../models/signal-sets').createTx;
const createSignal = require('../models/signals').createTx;
const {resolveAbs, getFieldsetPrefix} = require('../../shared/param-types-helpers');

const es = require('../lib/elasticsearch');
const {TYPE_JOBS, INDEX_JOBS, STATE_FIELD} = require('../lib/task-handler').esConstants

const {getSuccessEventType, getFailEventType, getOutputEventType, getStopEventType} = require('../lib/task-events');

const LOG_ID = 'Task-handler';

// Stores all incoming messages, meant to be processed
const workQueue = [];
const delayedMap = new Map();
const waitBuildMap = new Map();
const jobRunning = new Map();
let running = false;

const inProcessMsgs = new Map();

// Check interval is in seconds, so here is conversion
const checkInterval = config.tasks.checkInterval * 1000;

// Job handlers
const pythonHandler = require('./jobs/python-handler');
const handlers = new Map();
handlers.set(TaskType.PYTHON, pythonHandler);

em.invoke('services.task-handler.installHandlers', handlers);

const events = require('events');
const emitter = new events.EventEmitter();


class HandlerNotFoundError extends Error {
    constructor(msg, type) {
        super(msg);
        this.type = type;
    }
}

/* Message processing */
process.on('message', handleMsg);

function emit(eventType, data) {
    process.send({
        type: eventType,
        data: data
    })
}

/**
 * The incoming messages logistic.
 */
async function handleMsg(msg) {
    if (msg) {
        try {
            switch (msg.type) {
                case HandlerMsgType.RUN:
                    await handleRunMsg(msg);
                    break;
                case HandlerMsgType.DELETE_JOB:
                case HandlerMsgType.DELETE_TASK:
                case HandlerMsgType.BUILD:
                case HandlerMsgType.INIT:
                    workQueue.push(msg);
                    break;
                case HandlerMsgType.SIGNAL_TRIGGER:
                    await checkSignalTriggers(msg.spec.cid);
                    break;
                case HandlerMsgType.STOP:
                    await stop(msg);
                    break;
                default:
                    log.info(LOG_ID, `Unknown message type received: ${msg.type}`);
            }
            startIfNotRunning();
        } catch (error) {
            log.error(LOG_ID, error)
        }
    }
}

/**
 * Stop running job, if still running.
 * @param msg
 * @returns {Promise<void>}
 */
async function stop(msg) {
    const runId = msg.spec.runId;
    const index = workQueue.findIndex(i => {
        return i.spec.runId === runId;
    });

    const statusUpdate = async (runId) => await checkAndSetMsgRunStatus(runId, RunStatus.FAILED, "Run cancelled.")
        .catch(err => {
            log.warn(LOG_ID, err)
        });

    // If run is still in a queue, remove it otherwise it might be already running so invoke stop on handler
    // all phases of run handling should be exclusive
    if (index !== -1) {
        workQueue.splice(index, 1);
        await statusUpdate(runId);
    } else {
        const handler = inProcessMsgs.get(runId);
        if (handler) {
            try {
                // Update of run in DB is not necessary here as it will be done after interrupting the job
                await handler.stop(runId);
            } catch (err) {
                log.error(LOG_ID, err);
            }
        } else {
            // If the job is not running, it is possible that it has been delayed or is waiting for build to finish
            const waitObj = waitBuildMap.get(msg.spec.jobId);
            if (waitObj && waitObj.runId === runId) {
                const job = await knex('jobs').select('task').where({id: msg.spec.jobId}).first();
                emitter.removeListener(`build-${job.task}`, waitObj.callback);
                await statusUpdate(runId);
            } else {
                const timeout = delayedMap.get(msg.spec.jobId);
                if (timeout) {
                    clearTimeout(timeout);
                    delayedMap.delete(msg.spec.jobId);
                    await statusUpdate(runId);
                }
            }
        }
    }

    emit(getStopEventType(runId))
}

/**
 * Start and handle the work queue.
 */
function startIfNotRunning() {
    if (running) {
        return;
    }

    running = true;

    handleAll().catch(err => log.error(LOG_ID, err));
}

/**
 * Function invoked after delayed time has passed.
 * @param msg
 * @param task
 * @param job
 * @returns {Promise<void>}
 */
async function afterDelay(msg, task, job) {
    delayedMap.delete(job.id);
    await processRunMsg(msg, task, job);
}


/**
 * Prepare entities specifications for a job, like index name in es.
 * @param job
 * @param jobParams Stored job parameters
 * @param taskParams Set task parameters
 * @returns {Promise<void>}
 */
async function getEntitiesFromParams(job, jobParams, taskParams) {
    const entities = {
        signalSets: {},
        signals: {}
    };

    function getJobParamByRef(prefix = '/', ref) {

        const abs = ref ? resolveAbs(prefix, ref) : prefix;

        let walker = jobParams;
        const path = abs.split('/');
        // Path always starts with slash
        for (let i = 1; i < path.length; i++) {

            if (path[i] === '') {
                continue;
            }

            if (path[i].charAt(0) === '[') {
                walker = walker[path[i].slice(1, -1)];
            } else {
                walker = walker[path[i]];
            }

            if (!walker) {
                throw new Error(`Reference ${ref} not valid`);
            }
        }

        return walker;
    }

    async function addAllSignalsOfSignalSet(signalSet) {

        if (!entities.signals[signalSet.cid]) {
            entities.signals[signalSet.cid] = {};
        }

        const signals = await knex('signals').where({set: signalSet.id});
        for (const signal of signals) {
            if (entities.signals[signalSet.cid][signal.cid]) {
                // info already stored
                continue;
            }
            entities.signals[signalSet.cid][signal.cid] = getSignalEntitySpec(signal);
        }
    }

    function getSignalEntitySpec(signal) {
        return {
            ...signal,
            field: getFieldName(signal.id),
        };
    }

    function getSignalSetEntitySpec(signalSet) {
        return {
            ...signalSet,
            index: getIndexName(signalSet),
        };
    }

    // Walks all subtrees of params and gets info for signals and signalSets found
    async function loadFromParams(prefix, jobParamsSpec, taskParamsSpec) {

        for (let param of taskParamsSpec) {

            /* TODO check whether param can be undefined, if not throw error here for unspecified one
            let paramValue = jobParams[param.id];
            if (paramValue === undefined){
                        throw new Error(`Job doesn't specify parameter ${param.id}.`);
            }
            */

            switch (param.type) {
                case 'signalSet': {

                    const signalSetCid = jobParamsSpec[param.id];

                    if (!signalSetCid) {
                        throw new Error(`Job doesn't specify parameter ${param.id}.`);
                    }

                    if (entities.signalSets[signalSetCid]) {
                        // info already stored
                        continue;
                    }

                    const signalSet = await knex('signal_sets').where({cid: signalSetCid}).first();
                    if (!signalSet) {
                        throw new Error(`Set with cid ${signalSetCid} not found.`);
                    }


                    entities.signalSets[signalSetCid] = getSignalSetEntitySpec(signalSet);


                    if (param.includeSignals === true) {
                        await addAllSignalsOfSignalSet(signalSet);
                    }

                    break;
                }

                case 'signal': {

                    const signalSetCid = param.signalSetRef ? getJobParamByRef(prefix, param.signalSetRef) : param.signalSet;
                    if (!signalSetCid) {
                        throw new Error(`Signal set's cid for parameter ${param.id} not specified.`);
                    }

                    let signalCids = jobParamsSpec[param.id];

                    if (!signalCids) {
                        throw new Error(`Signal's cid for parameter ${param.id} not specified.`);
                    }

                    // Single select
                    if (!Array.isArray(signalCids)) {
                        signalCids = [signalCids];
                    }

                    for (const signalCid of signalCids) {
                        if (entities.signals[signalSetCid]) {
                            if (entities.signals[signalSetCid][signalCid]) {
                                // info already stored
                                continue;
                            }
                        } else {
                            entities.signals[signalSetCid] = {};
                        }

                        const signalSet = await knex('signal_sets').select('id').where({cid: signalSetCid}).first();
                        if (!signalSet) {
                            throw new Error(`Signal set with cid ${param.cid} not found.`);
                        }


                        const signal = await knex('signals').where({cid: signalCid, set: signalSet.id}).first();
                        if (!signal) {
                            throw new Error(`Signal with cid ${signalCid} in set ${signalSet.id} not found.`);
                        }

                        entities.signals[signalSetCid][signalCid] = getSignalEntitySpec(signal);
                    }
                    break;
                }

                case 'fieldset': {
                    if (param.children) {
                        let idx = 0;

                        let jobParamSpec = jobParamsSpec[param.id];

                        if (!Array.isArray(jobParamSpec)) {
                            jobParamSpec = [jobParamSpec];
                        }

                        for (const child of jobParamSpec) {
                            await loadFromParams(getFieldsetPrefix(prefix, param, idx), child, param.children);
                            idx++;
                        }
                    }
                    break;
                }

                default:
                    break;
            }


        }
    }

    await loadFromParams('/', jobParams, taskParams);
    // Load all owned signal sets
    const ownedSignalSets = await getSignalSetsOwnedByJob(job.id);
    for (const signalSet of ownedSignalSets) {
        if (!entities.signalSets[signalSet.cid]) {
            entities.signalSets[signalSet.cid] = getSignalSetEntitySpec(signalSet);
        }
        await addAllSignalsOfSignalSet(signalSet);
    }

    return entities;
}

async function getSignalSetsOwnedByJob(jobId) {
    return await knex('signal_sets_owners').select('signal_sets.*').innerJoin('signal_sets', function () {
        this.on('signal_sets_owners.set', '=', 'signal_sets.id').andOn('signal_sets_owners.job', '=', jobId);
    });
}

/**
 * As there are 2 types of possible messages, one with run instance already created and one without, this function checks
 * for it and updates DB accordingly.
 * @param runId
 * @param status
 * @param output
 * @returns {Promise<void>}
 */
async function checkAndSetMsgRunStatus(runId, status, output) {
    if (runId) {
        await updateRun(runId, {
            status: status,
            output: output
        });
    }
}

async function getOwnedEntities(job) {
    const owned = {
        signalSets: {}
    };
    const ownedSignalSets = await getSignalSetsOwnedByJob(job.id);
    for (const signalSet of ownedSignalSets) {
        owned.signalSets[signalSet.cid] = {}
    }

    return owned;
}

/**
 * This is a core of run msg handling process, where msg always ends up being in the work queue.
 * @param msg
 * @param task
 * @param job
 * @returns {Promise<void>}
 */
async function processRunMsg(msg, task, job) {
    const spec = msg.spec;
    try {
        spec.params = JSON.parse(job.params);
        spec.entities = await getEntitiesFromParams(job, spec.params, JSON.parse(task.settings).params);
        spec.owned = await getOwnedEntities(job);
    } catch (error) {
        return void await onRunFail(job.id, spec.runId, null, error.message);
    }
    spec.taskType = task.type;

    if (!spec.runId) {
        msg.spec.runId = await createRun(job.id, RunStatus.SCHEDULED);
    } else {
        await updateRun(spec.runId, {status: RunStatus.SCHEDULED});
    }

    const lastRun = await knex('job_runs').where({
        job: job.id,
        status: RunStatus.SUCCESS
    }).orderBy('started_at', 'desc').first();

    // Check whether job will join the work queue immediately or will have to wait for the chosen minimal
    // interval between jobs to pass
    if (lastRun && job.min_gap && job.min_gap !== 0) {
        const timeFromLast = moment(Date.now()).diff(moment(lastRun.started_at), 'seconds');
        const gap = job.min_gap - timeFromLast;
        if (gap > 0) {
            setTimeout((msg) => {
                workQueue.push(msg);
                startIfNotRunning()
            }, gap * 1000, msg);
        } else {
            workQueue.push(msg);
        }
    } else {
        workQueue.push(msg);
    }
}

/**
 * When task is being build when run command arrives, this function is run after the build is finished.
 * @param buildState State of the finished build
 * @param jobId Id of the job waiting
 * @param msg Run msg that should be handled after successful build
 */
function afterBuildListener(buildState, jobId, msg) {
    waitBuildMap.delete(jobId);
    if (buildState === BuildState.FINISHED) {
        handleRunMsg(msg).catch((err) => log.error(LOG_ID, err))
    } else {
        onRunFail(jobId, msg.spec.runId, null, "Task not build.").catch((err) => log.error(LOG_ID, err));
    }
}


/**
 * Check if run conforms to all the necessary condition for run and if so, prepares data for work queue join.
 * @param msg
 * @returns {Promise<void>}
 */
async function handleRunMsg(msg) {
    let job;
    let task;
    const spec = msg.spec;
    const jobId = spec.jobId;

    // Reason for separate functions is that one also deletes running job flags. That,
    // if not used by job currently running, could lead to two jobs running at the same time.
    const failRun = async (errMsg) => await onRunFail(jobId, spec.runId, null, errMsg);
    const failCheckRun = async (errMsg) => await handleRunFail(jobId, spec.runId, null, errMsg);

    await knex.transaction(async tx => {
        job = await tx('jobs').where('id', jobId).first();
        task = await tx('tasks').where('id', job.task).first();
    });

    if (!job) {
        return void await failCheckRun(`Job ${jobId} not found.`);
    }

    if (!task) {
        return void await failCheckRun(`Task ${job.task} not found.`);
    }

    if (job.state === JobState.INVALID_PARAMS) {
        return void await failCheckRun(`Task ${task.name} had parameters changed, please update ${job.name} job's parameters first.`);
    }


    if (task.build_state === BuildState.FINISHED) {

        if (jobRunning.get(jobId)) {
            return void await failCheckRun(`Job ${job.name} already running`);
        }
        jobRunning.set(jobId, true);

        if (job.delay && job.delay > 0) {
            const timeout = setTimeout(afterDelay, job.delay * 1000, msg, task, job);
            delayedMap.set(job.id, timeout);
        } else {
            await processRunMsg(msg, task, job);
        }
    } else {
        // Task isn't built but if it is building, the job will wait for it to finish and try to run again
        if (!isTransitionState(task.build_state)) {
            return void await failRun(`Task ${task.name} is not build.`);
        }

        if (!waitBuildMap.get(jobId)) {
            const cb = (state) => afterBuildListener(state, jobId, msg);
            waitBuildMap.set(jobId, {runId: spec.runId, callback: cb});
            emitter.once(`build-${task.id}`, cb);
        } else {
            await failCheckRun(`Task ${task.name} is being build and job is already queued to run after build.`);
        }
    }


}

/**
 * Handle all requests currently in the work queue.
 * @returns {Promise<void>}
 */
async function handleAll() {

    while (workQueue.length > 0) {
        const workEntry = workQueue.shift();
        const type = workEntry.type;
        try {
            switch (type) {
                case HandlerMsgType.BUILD:
                    await handleBuild(workEntry);
                    break;
                case HandlerMsgType.INIT:
                    await handleInit(workEntry);
                    break;
                case HandlerMsgType.RUN:
                    await handleRun(workEntry);
                    break;
                case HandlerMsgType.DELETE_TASK:
                    await handleTaskDelete(workEntry);
                    break;
                case HandlerMsgType.DELETE_JOB:
                    await handleJobDelete(workEntry);
                    break;
                default:
                    break;
            }

        } catch (err) {
            log.error(LOG_ID, err);
        }
    }

    running = false;
}


/**
 * Store run info in the DB.
 * @param jobId Id of the job.
 * @param status Status of the run.
 * @returns {Promise<void>}
 */
async function createRun(jobId, status) {
    const runId = await knex('job_runs').insert({
        job: jobId,
        status: status,
        started_at: new Date()
    });
    return runId[0];
}

/**
 *  Update run
 * @param runId
 * @param columns
 * @returns {Promise<void>}
 */
async function updateRun(runId, columns) {
    try {
        await knex('job_runs').where('id', runId).update(columns);
    } catch (err) {
        log.error(`Run ${runId} couldn't be updated.`, err);
    }
}

/**
 * Update state of a the job.
 * @param id
 * @param state
 * @param output
 * @returns {Promise<void>}
 */
async function setState(id, state, output) {
    const data = {};
    data.build_state = state;
    if (output) {
        data.build_output = JSON.stringify(output);
    }
    await knex('tasks').where('id', id).update(data);
}


/* ---------- DELETE ---------- */
/**
 * Handle removal task.
 * @param workEntry
 * @returns {Promise<void>}
 */
async function handleTaskDelete(workEntry) {
    const spec = workEntry.spec;
    const id = spec.taskId;
    const type = spec.type;

    const handler = getHandlerForType(type);
    if (!handler) {
        log.warn(LOG_ID, 'Handler for type not found');
    } else {
        await handler.remove(id);
    }
}

async function handleJobDelete(workEntry) {
    const spec = workEntry.spec;
    const id = spec.jobId;
    // Remove config of the job
    try {
        await es.delete({
            index: INDEX_JOBS,
            type: TYPE_JOBS,
            id: id
        });
    } catch (err) {
        log.warn(LOG_ID, err);
    }
}

/*--------------------------*/

/* ---------- BUILD ---------- */

/**
 * Callback for successful build.
 * @param id
 * @param warnings
 * @returns {Promise<void>}
 */
async function onBuildSuccess(id, warnings) {
    const output = {};
    output.warnings = warnings ? warnings : [];
    output.errors = [];

    await setState(id, BuildState.FINISHED, output);

    emitter.emit(`build-${id}`, BuildState.FINISHED);
}

/**
 * Callback for failed build.
 * @param id
 * @param warnings
 * @param errors
 * @returns {Promise<void>}
 */
async function onBuildFail(id, warnings, errors) {
    const output = {};
    output.warnings = warnings ? warnings : [];
    output.errors = errors ? errors : [];

    await setState(id, BuildState.FAILED, output);
    emitter.emit(`build-${id}`, BuildState.FAILED);
}

/**
 * Handle build task.
 * @param workEntry
 * @returns {Promise<void>}
 */
async function handleBuild(workEntry) {
    const spec = workEntry.spec;
    const id = spec.taskId;
    const handler = await getHandler(id);
    if (!handler) {
        await onBuildFail(id, null, [`Handler for type not found: ${spec.type}`]);
    } else {
        try {
            await setState(id, BuildState.PROCESSING);

            await handler.build(
                {
                    id,
                    code: spec.code,
                    destDir: spec.destDir
                },
                (warnings) => onBuildSuccess(id, warnings),
                (warnings, errors) => onBuildFail(id, warnings, errors));
        } catch (err) {
            log.error(`${LOG_ID} build operation`, err);
        }
    }
}


/**
 * Callback for failed build.
 * @param id
 * @param warnings
 * @param errors
 * @returns {Promise<void>}
 */
async function onInitFail(id, warnings, errors) {
    const output = {};
    output.warnings = warnings ? warnings : [];
    output.errors = errors ? errors : [];

    await setState(id, BuildState.UNINITIALIZED, output);
    emitter.emit(`build-${id}`, BuildState.FAILED);
}

/**
 * Handle init task.
 * @param workEntry
 * @returns {Promise<void>}
 */
async function handleInit(workEntry) {
    const spec = workEntry.spec;
    const id = spec.taskId;
    const handler = await getHandler(id);
    if (!handler) {
        await onInitFail(id, null, [`Handler for type not found: ${spec.type}`]);
    } else {
        try {
            await setState(id, BuildState.INITIALIZING);
            const task = await knex.table('tasks').where('id', id).first();
            const subtype = JSON.parse(task.settings).subtype;
            await handler.init(
                {
                    id: id,
                    subtype: subtype,
                    code: spec.code,
                    destDir: spec.destDir
                },
                (warnings) => onBuildSuccess(id, warnings),
                (warnings, errors) => onInitFail(id, warnings, errors));
        } catch (err) {
            log.error(`${LOG_ID} init operation`, err);
        }
    }
}

/*--------------------------*/

/* ---------- RUN ---------- */


/**
 * Run fail handler. Used as the exit point for run msg handling process.
 * @param jobId
 * @param runId
 * @param runData
 * @param errMsg Error description
 * @returns {Promise<void>}
 */
async function onRunFail(jobId, runId, runData, errMsg) {

    jobRunning.delete(jobId);
    inProcessMsgs.delete(runId);

    await handleRunFail(jobId, runId, runData, errMsg);
    emit(getFailEventType(runId), errMsg);
}

async function handleRunFail(jobId, runId, runData, errMsg) {
    if (runId) {
        if (!runData) {
            runData = {};
        }

        runData.finished_at = new Date();
        runData.status = RunStatus.FAILED;
        runData.output = errMsg ? errMsg : '';
        try {
            const run = await knex('job_runs').select('output').where('id', runId).first();
            runData.output = [errMsg, `Log:\n${run.output}`].join('\n\n');
            await updateRun(runId, runData);
        } catch (err) {
            log.error(LOG_ID, err);
        }
    } else {
        if (errMsg) {
            log.error(LOG_ID, `Job ${jobId} run failed: ` + errMsg);
        }
    }
}


function parseRequest(req) {
    return JSON.parse(req);
}


async function handleRequest(jobId, requestStr) {
    let response = {};

    if (!requestStr) {
        response.error = "Request not specified";
        return response;
    }

    let request = {};
    try {
        request = parseRequest(requestStr);

        if (request.id) {
            response.id = request.id;
        }

    } catch (err) {
        response.error = `Request parsing failed: ${err.message}`;
        return response;
    }

    if (!request.type) {
        response.error = "Type not specified";
        return response;
    }

    try {
        switch (request.type) {
            case JobMsgType.CREATE_SIGNALS:
                if (request.signalSets || request.signals) {
                    const reqResult = await processCreateRequest(jobId, request.signalSets, request.signals);
                    response = {
                        ...response,
                        ...reqResult
                    };
                } else {
                    response.error = `Either signalSets or signals have to be specified`;
                }
                break;
            case  JobMsgType.STORE_STATE:
                if (request[STATE_FIELD]) {
                    const reqResult = await storeRunState(jobId, request[STATE_FIELD]);
                    response = {
                        ...response,
                        ...reqResult
                    };
                } else {
                    response.error(`${STATE_FIELD} not specified`)
                }
                break;
            default:
                response.error = `Type ${request.type} not recognized`;
                break;
        }
    } catch (error) {
        log.warn(LOG_ID, error);
        response.error = error.message;
    }
    return response;
}

/**
 * @typedef {Object} IndexInfo
 * @property {string} index - Created index name.
 * @property {Object[]} fields - map of signal cid to his field name in created index
 */

// TODO - we would need something similar for signals

/**
 * Process request for signal set and signals creation
 * Signals are specified in sigSet.signals
 * Uses same data format as web creation
 * @param jobId
 * @param signalSets
 * @param signalsSpec
 * @returns {Promise<IndexInfo>} Created indices and mapping
 */
async function processCreateRequest(jobId, signalSets, signalsSpec) {
    const esInfo = {};

    async function createSignalSetWithSignals(tx, signalSet) {

        const esSetInfo = {};

        let signals = signalSet.signals;
        delete signalSet.signals;

        signalSet.type = SignalSetType.COMPUTED;

        signalSet.id = await createSigSet(tx, getAdminContext(), signalSet);
        esSetInfo.index = getIndexName(signalSet);
        esSetInfo.type = TYPE_JOBS;

        esSetInfo.fields = {};
        if (signals) {
            if (!Array.isArray(signals)) {
                signals = [signals];
            }

            for (const signal of signals) {
                // Here are possible overwrites of input from job
                signal.weight_list = 0;
                signal.weight_edit = null;
                signal.source = SignalSource.JOB;
                const sigId = await createSignal(tx, getAdminContext(), signalSet.id, signal);
                esSetInfo['fields'][signal.cid] = getFieldName(sigId);
            }
        }

        await tx('signal_sets_owners').insert({job: jobId, set: signalSet.id});
        return esSetInfo;
    }

    async function createComputedSignal(tx, signalSetId, signal) {
        // Here are possible overwrites of input form job
        signal.weight_list = 0;
        signal.weight_edit = null;
        signal.source = SignalSource.JOB;
        const sigId = await createSignal(tx, getAdminContext(), signalSetId, signal);

        // TODO should add something like signal_sets_owners for signals probably
        return getFieldName(sigId);
    }

    try {
        await knex.transaction(async (tx) => {
            if (signalSets) {
                if (Array.isArray(signalSets)) {
                    for (let signalSet of signalSets) {
                        esInfo[signalSet.cid] = await createSignalSetWithSignals(tx, signalSet);
                    }
                } else {
                    esInfo[signalSets.cid] = await createSignalSetWithSignals(tx, signalSets);
                }
            }

            if (signalsSpec) {
                for (let [sigSetCid, signals] of Object.entries(signalsSpec)) {
                    const sigSet = await tx('signal_sets').where('cid', sigSetCid).first();
                    if (!sigSet) {
                        throw new Error(`Signal set with cid ${sigSetCid} not found`);
                    }

                    esInfo[sigSetCid] = {};
                    esInfo[sigSetCid]['index'] = getIndexName(sigSet);
                    esInfo[sigSetCid]['type'] = TYPE_JOBS;
                    esInfo[sigSetCid]['fields'] = {};

                    if (!Array.isArray(signals)) {
                        signals = [signals];
                    }

                    for (let signal of signals) {
                        esInfo[sigSetCid]['fields'][signal.cid] = await createComputedSignal(tx, sigSet.id, signal);
                    }

                }
            }
        });
    } catch (error) {
        log.warn(LOG_ID, error);
        esInfo.error = error.message;
    }

    return esInfo;
}

/**
 * Load saved config from elasticsearch
 * @param id
 * @returns {Promise<void>} config field retrieved from ES
 */
async function loadJobState(id) {
    try {
        const jobState = await es.get({index: INDEX_JOBS, type: TYPE_JOBS, id: id, filter_path: ['_source']});

        return jobState['_source'][STATE_FIELD];

    } catch (err) {
        if (err.status === 404 && err.displayName === 'NotFound') {
            log.info(LOG_ID, `State for job ${id} not found`);
        } else {
            log.error(LOG_ID, err);
        }

        return null;
    }
}

/**
 * Store config from job, overwrites old config
 * @param id ID of the job config belongs to
 * @param state Config to store, JSON format
 * @returns {Promise<void>}
 */
async function storeRunState(id, state) {
    const jobBody = {};
    jobBody[STATE_FIELD] = state;
    try {
        await es.index({index: INDEX_JOBS, type: TYPE_JOBS, id: id, body: jobBody});
    } catch (err) {
        return {error: err.message};
    }
}

function createRunHandler(jobId, runId) {
    const runData = {};
    runData.started_at = new Date();

    const maxOutput = config.tasks.maxRunOutputBytes || 1000000;
    let outputBytes = 0;
    let limitReached = false;
    let outputBuffer = [];
    let timer;

    return {
        onRunEvent,
        onRunSuccess,
        onRunFail: onRunFailFromRunningStatus
    }

    async function onRunFailFromRunningStatus(errMsg) {
        await cleanBuffer();
        await onRunFail(jobId, runId, runData, errMsg);
    }

    /**
     * Callback for successful run.
     * @param config
     * @returns {Promise<void>}
     */
    async function onRunSuccess(config) {
        await cleanBuffer();

        inProcessMsgs.delete(runId);
        jobRunning.delete(jobId);
        runData.finished_at = new Date();
        runData.status = RunStatus.SUCCESS;
        try {
            await updateRun(runId, runData);
            if (config) {
                await storeRunState(config);
            }
        } catch (err) {
            log.error(LOG_ID, err);
        }
        emit(getSuccessEventType(runId));
    }

    async function cleanBuffer() {
        try {
            if (outputBuffer.length > 0) {
                let output = [...outputBuffer];
                outputBuffer = [];
                emit(getOutputEventType(runId), output);
                await knex('job_runs').update({output: knex.raw('CONCAT(COALESCE(`output`,\'\'), ?)', output.join(''))}).where('id', runId);
            }
            timer = null;
        } catch (e) {
            log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
            outputBuffer = [];
            timer = null;
        }
    }

    async function onRunEvent(type, data) {
        switch (type) {
            case 'output':
                try {
                    if (!limitReached) {
                        let byteLength = Buffer.byteLength(data, 'utf8');
                        outputBytes += byteLength
                        if (outputBytes >= maxOutput) {
                            limitReached = true;
                            if (config.tasks.printLimitReachedMessage === true) {
                                try {
                                    await knex('job_runs').update({output: knex.raw('CONCAT(`output`, \'INFO: max output storage capacity reached\')')}).where('id', runId);

                                    const maxMsg = 'INFO: max output capacity reached'
                                    if (!timer) {
                                        emit(getOutputEventType(runId), maxMsg);
                                    } else {
                                        outputBuffer.push(maxMsg);
                                    }
                                } catch (e) {
                                    log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
                                }
                            }
                        } else {
                            outputBuffer.push(data);
                            // TODO Don't know how well this will scale
                            // --   it might be better to append to a file, but this will require further syncing
                            // --   as we need full output for task development in the UI, not only output after the register of listener
                            // --   therefore keeping it this way for now
                            if (!timer) {
                                timer = setTimeout(cleanBuffer, 1000);
                            }
                        }
                    }

                } catch (e) {
                    log.error(LOG_ID, `Output handling for the run ${runId} failed`, e);
                }
                break;
            case 'request':
                return await handleRequest(jobId, data);
            default:
                log.info(LOG_ID, `Job ${jobId} run ${runId}: unknown event ${type} `);
                break;
        }
    }
}

/**
 * Handle run task.
 * @returns {Promise<void>}
 * @param workEntry
 */
async function handleRun(workEntry) {
    const spec = workEntry.spec;
    const runId = spec.runId;
    const jobId = spec.jobId;
    const handler = await getHandlerForJob(jobId);
    try {
        if (!handler) {
            throw new HandlerNotFoundError('Handler for type not found', spec.id);
        }

        await updateRun(runId, {status: RunStatus.RUNNING});
        inProcessMsgs.set(runId, handler);

        const runConfig = {
            jobId: jobId,
            runId: runId,
            taskDir: spec.taskDir,
            inputData: {
                params: spec.params,
                entities: spec.entities,
                owned: spec.owned,
                state: await loadJobState(jobId)
            }
        };

        const runHandler = createRunHandler(jobId, runId);

        handler.run(
            runConfig,
            runHandler.onRunEvent,
            runHandler.onRunSuccess,
            runHandler.onRunFail
        );

    } catch (err) {
        log.error(LOG_ID, err);
        await updateRun(spec.runId, {status: RunStatus.FAILED});
    }

}

/*--------------------------*/

/**
 * Return handler for type or null if none is found.
 * @param id the primary key of the job
 * @returns {Promise<null>}
 */
async function getHandlerForJob(id) {
    const job = await knex('jobs').where('id', id).first();
    if (job) {
        return await getHandler(job.task);
    } else {
        return null;
    }
}

/**
 * Returns handle for the type or null if none exists.
 * @param type of the task
 * @returns {Promise<null>}
 */
function getHandlerForType(type) {
    if (type) {
        return handlers.get(type);
    } else {
        return null;
    }
}

/**
 * Returns handler for the type of the task.
 * @param id the primary key of the task
 * @returns {Promise<null>}
 */
async function getHandler(id) {
    const task = await knex('tasks').where('id', id).first();
    return task ? handlers.get(task.type) : null;
}

/**
 * Returns run message for job.
 * @param job the job to run
 */
function createRunMsg(job) {
    return {
        type: HandlerMsgType.RUN,
        spec: {
            jobId: job.id,
            taskDir: getTaskBuildOutputDir(job.task)
        }
    };
}

/**
 * Find all jobs with specified signal set trigger.
 * @param cid
 */
async function checkSignalTriggers(cid) {
    let triggers = [];
    await knex.transaction(async tx => {
        let id = await tx('signal_sets').select('id').where('cid', cid).first();
        triggers = await tx('job_triggers').select('job').where('signal_set', id.id);
    });

    for (let trigger of triggers) {
        const job = await knex('jobs').where('id', trigger.job).first();
        if (job.state === JobState.ENABLED) {
            const msg = createRunMsg(job);
            handleRunMsg(msg).catch(logErr);
        }
    }
}

/**
 * Check and if time trigger is due on a job, run it.
 * @param job Job to check time trigger for.
 * @returns {Promise<void>}
 */
async function runTimeTrigger(job) {
    // If there is time trigger set check for it
    if (job.trigger !== null && job.trigger !== 0) {

        const last_run = await knex('job_runs').where({
            job: job.id,
            status: RunStatus.SUCCESS
        }).orderBy('started_at', 'desc').first();

        // If job haven't run yet, run.
        if (last_run && last_run.started_at) {
            let timeFromLast = moment(Date.now()).diff(moment(last_run.started_at), 'seconds');
            if (timeFromLast > job.trigger) {
                await handleRunMsg(createRunMsg(job));
            }
        } else {
            await handleRunMsg(createRunMsg(job));
        }

    }
}

/**
 * For all jobs check if it should be time triggered and run accordingly.
 * @returns {Promise<void>}
 */
async function runTimeTriggers() {
    try {
        const jobs = await knex('jobs').where('state', JobState.ENABLED);

        if (jobs) {
            for (let i = 0; i < jobs.length; i++) {
                await runTimeTrigger(jobs[i]).catch(logErr);
            }
        }
        startIfNotRunning();
    } catch (err) {
        log.error(LOG_ID, err);
    }
}

function logErr(err) {
    log.error(LOG_ID, err.stack);
}

// This line starts the time trigger functionality
setInterval(runTimeTriggers, checkInterval);
log.info(LOG_ID, 'Job handler process started');

