'use strict';
const path = require('path');
const fs = require('fs-extra-promise');
const spawn = require('child_process').spawn;
const {PythonSubtypes, defaultSubtypeKey} = require('../../../shared/tasks');
const readline = require('readline');
const ivisConfig = require('../../lib/config');
const em = require('../../lib/extension-manager');

// File name of every build output
const JOB_FILE_NAME = 'job.py';
// Directory name where virtual env is saved for task
const ENV_NAME = 'env';
const IVIS_PCKG_DIR = path.join(__dirname, '..', '..', 'lib', 'tasks', 'python', 'ivis', 'dist');

const runningProc = new Map();

const defaultPythonLibs = ['elasticsearch'];
const taskSubtypeSpecs = {
    [defaultSubtypeKey]: {
        libs: defaultPythonLibs
    },
    [PythonSubtypes.ENERGY_PLUS]: {
        libs: [...defaultPythonLibs, 'eppy', 'requests']
    },
    [PythonSubtypes.NUMPY]: {
        libs: [...defaultPythonLibs, 'numpy', 'dtw']
    }
};

em.invoke('services.task-handler.python-handler.installSubtypeSpecs', taskSubtypeSpecs);

/**
 * Run job
 * @param id Job id
 * @param runId Run ID, will be used by stop command
 * @param taskDir Directory with the task
 * @param onEvent
 * @param onSuccess Callback on successful run
 * @param onFail callback on failed run
 * @returns {Promise<void>}
 */
async function run({jobId, runId, taskDir, inputData}, onEvent, onSuccess, onFail) {
    try {
        let errOutput = '';

        const dataInput = {
            params: {},
            es: {
                host: `${ivisConfig.elasticsearch.host}`,
                port: `${ivisConfig.elasticsearch.port}`
            },
            ...inputData
        };

        const pythonExec = path.join(taskDir, ENV_NAME, 'bin', 'python');
        const jobProc = spawn(`${pythonExec} ${JOB_FILE_NAME}`, {
            cwd: taskDir,
            shell: '/bin/bash',
            stdio: ['pipe', 'pipe', 'pipe', 'pipe']
        });

        const jobOutStream = readline.createInterface({
            input: jobProc.stdio[3]
        });

        jobOutStream.on('line', (input) => {
            onEvent('request', input)
                .then(msg => {
                    jobProc.stdin.write(JSON.stringify(msg) + '\n');
                })
                .catch(err => {
                    errOutput += err;
                });
        });

        runningProc.set(runId, jobProc);
        let storeConfig = null;

        // Send all configs and params to process on stdin in json format
        jobProc.stdin.write(JSON.stringify(dataInput) + '\n');

        // Error output is just gathered throughout the run and stored after run is done
        jobProc.stderr.on('data', (data) => {
            errOutput += data + '\n';
        });

        // Same as with error output
        jobProc.stdout.on('data', (data) => {
            const outputStr = data.toString();
            onEvent('output', outputStr);
        });

        const pipeErrHandler = (err) => {
            errOutput += err;
            onEvent('output', err);
        };

        jobProc.stdin.on('error', pipeErrHandler);
        jobProc.stderr.on('error', pipeErrHandler);
        jobProc.stdout.on('error', pipeErrHandler);
        jobProc.stdio[3].on('error', pipeErrHandler);

        jobProc.on('error', (err) => {
            runningProc.delete(runId);
            const failMsg = [err.toString(), 'Error log:\n' + errOutput].join('\n\n');
            onFail(failMsg);
        });

        jobProc.on('exit', (code, signal) => {
            runningProc.delete(runId);
            if (code === 0) {
                onSuccess(storeConfig);
            } else {
                const failMsg = [`Run failed with code ${code}`, 'Error log:\n' + errOutput].join('\n\n');
                onFail(failMsg);
            }
        });
    } catch (error) {
        onFail([error.toString()]);
    }
}


/**
 * Remove job
 * @param id
 * @returns {Promise<void>}
 */
async function remove(id) {
    // Nothing
}

function getPackages(subtype) {
    return subtype ? taskSubtypeSpecs[subtype].libs : taskSubtypeSpecs[defaultSubtypeKey].libs;
}

function getCommands(subtype) {
    return subtype ? taskSubtypeSpecs[subtype].cmds : taskSubtypeSpecs[defaultSubtypeKey].cmds;
}

/**
 * Build task
 * @param config
 * @param onSuccess Callback on success
 * @param onFail Callback on failed build
 * @returns {Promise<void>}
 */
async function build(config, onSuccess, onFail) {
    const {id, code, destDir} = config;
    let buildDir;
    try {
        buildDir = path.join(destDir, '..', 'build');
        await fs.emptyDirAsync(buildDir);
        const filePath = path.join(buildDir, JOB_FILE_NAME);
        await fs.writeFileAsync(filePath, code);
        await fs.moveAsync(filePath, path.join(destDir, JOB_FILE_NAME), {overwrite: true});
        await fs.removeAsync(buildDir);
        await onSuccess(null);
    } catch (error) {
        if (buildDir) {
            await fs.remove(buildDir);
        }
        onFail(null, [error.toString()]);
    }
}

/**
 * Initialize and build task.
 * @param config
 * @param onSuccess Callback on success
 * @param onFail Callback on failed attempt
 * @returns {Promise<void>}
 */
async function init(config, onSuccess, onFail) {
    const {id, subtype, code, destDir} = config;
    try {
        const packages = getPackages(subtype);
        const commands = getCommands(subtype);
        const buildDir = path.join(destDir, '..', 'build');
        await fs.emptyDirAsync(buildDir);

        const filePath = path.join(buildDir, JOB_FILE_NAME);
        await fs.writeFileAsync(filePath, code);

        const envDir = path.join(buildDir, ENV_NAME);

        const virtDir = path.join(envDir, 'bin', 'activate');

        const cmdsChain = []
        cmdsChain.push(`${ivisConfig.tasks.python.venvCmd} ${envDir}`)
        cmdsChain.push(`source ${virtDir}`)
        cmdsChain.push(`pip install ${packages.join(' ')} `)
        if (commands) {
            cmdsChain.push(...commands)
        }
        cmdsChain.push(`pip install --no-index --find-links=${IVIS_PCKG_DIR} ivis `)
        cmdsChain.push(`deactivate`)
        const virtEnv = spawn(
            cmdsChain.join(' && '),
            {
                shell: '/bin/bash'
            }
        );

        virtEnv.on('error', async (error) => {
            console.log(error);
            onFail(null, [error.toString()]);
            await fs.removeAsync(buildDir);
        });

        let output = '';
        virtEnv.stderr.setEncoding('utf8');
        virtEnv.stderr.on('data', data => {
            output += data.toString();
        });

        virtEnv.stdout.setEncoding('utf8');
        virtEnv.stdout.on('data', data => {
            output += data.toString();
        });

        virtEnv.on('exit', async (code, signal) => {
            if (code === 0) {
                await fs.moveAsync(buildDir, destDir, {overwrite: true});
                await onSuccess(null);
            } else {
                await onFail(null, [`Init ended with code ${code} and the following error:\n${output}`]);
            }
            await fs.removeAsync(buildDir);
        });
    } catch (error) {
        console.log(error);
        onFail(null, [error.toString()]);
    }
}

/**
 * Stop running job
 * @param runId
 * @returns {Promise<void>}
 */
async function stop(runId) {
    const proc = runningProc.get(runId);
    if (proc) {
        proc.kill('SIGINT');
    }
    // TODO check the possibilty of run being on event loop
    // meaning that there is no runningProc registered on that id, but the run is in wait
    // as run is async function and job-handler doest not await on it

}

module.exports = {
    run,
    remove,
    build,
    init,
    stop
};

