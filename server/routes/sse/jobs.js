'use strict';

const passport = require('../../lib/passport');
const {getFailEventType, getSuccessEventType, getStopEventType, getOutputEventType, emitter, EventTypes} = require('../../lib/task-events');
const jobs = require('../../models/jobs')

const shares = require('../../models/shares');
const knex = require('../../lib/knex');
const router = require('../../lib/router-async').create();
const {castToInteger} = require('../../lib/helpers');

const {initEventSource, sendEvent} = require('./helpers');

// RUNS

router.getAsync('/jobs/:jobId/run/:runId', passport.loggedIn, async (req, res) => {
    const jobId = castToInteger(req.params.jobId)
    const runId = castToInteger(req.params.runId)

    await shares.enforceEntityPermission(req.context, 'job', jobId, 'view');

    initEventSource(res);

    const sendOutput = (output) => sendEvent(res, 'output', output);
    const handleStop = () => {cleanup(); sendEvent(res, "stop", "Run has been stopped")};
    const handleSuccess = () =>   {cleanup(); sendEvent(res, "success", "Run has succeeded")};
    const handleFail = (errMsg) => {cleanup(); sendEvent(res, "error", errMsg)};

    emitter.addListener(getOutputEventType(runId), send);
    emitter.once(getStopEventType(runId), handleStop);
    emitter.once(getSuccessEventType(runId), handleSuccess);
    emitter.once(getFailEventType(runId), handleFail);

    req.on("close", cleanup);

    let initDone = false;
    let outputs = [];

    try {
        const run = await jobs.getRunById(req.context, jobId, runId);
        run.hash = jobs.hash(run);
        run.output = run.output || '';
        sendEvent(res, 'init', run)

        outputs.forEach((output) => {
            sendOutput(output);
        });
        outputs = null;

        initDone = true;
    } catch (error) {
        sendEvent(res, 'error', error)
    }


    function send(output) {
        if (initDone) {
            sendOutput(output);
        } else {
            outputs.push(output);
        }
    }

    function cleanup() {
        emitter.removeListener(getOutputEventType(runId), send);
        emitter.removeListener(getStopEventType(runId), handleStop);
        emitter.removeListener(getSuccessEventType(runId), handleSuccess);
        emitter.removeListener(getFailEventType(runId), handleFail);
    }
});

module.exports = router;
