'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {requiresAuthenticatedUser, withPageHelpers} from "../../lib/page";
import {ACEEditor, Button, filterData, Form, FormSendMethod, withForm} from "../../lib/form";
import "brace/mode/json";
import "brace/mode/python";
import "brace/mode/text";
import {withAsyncErrorHandler, withErrorHandling} from "../../lib/error-handling";
import {Panel} from "../../lib/panel";
import developStyles from "./Develop.scss";
import {ActionLink} from "../../lib/bootstrap-components";
import IntegrationTabs from "./IntegrationTabs";
import Files from "../../lib/files";
import {TaskType} from "../../../../shared/tasks";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import axios from "../../lib/axios";
import {getUrl} from "../../lib/urls";
import {RunStatus} from "../../../../shared/jobs";

const SaveState = {
    SAVED: 0,
    SAVING: 1,
    CHANGED: 2
};

const defaultEditorHeight = 600;

const typeToEditor = new Map();
typeToEditor.set(TaskType.PYTHON, 'python');
typeToEditor.set(TaskType.NUMPY, 'python');
typeToEditor.set(TaskType.ENERGY_PLUS, 'python');

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withForm,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class Develop extends Component {
    constructor(props) {
        super(props);

        this.taskTypes = {};

        this.state = {
            activeTab: null,
            saveState: SaveState.SAVED,
            isMaximized: false,
            withIntegration: false,
            editorHeight: defaultEditorHeight,
            taskVersionId: 0,
            fileToDeleteName: null,
            fileToDeleteId: null,
            chunkCounter: 0
        };

        this.runOutputChunks = [];

        const t = props.t;

        this.saveLabels = {
            [SaveState.CHANGED]: t('Save'),
            [SaveState.SAVING]: t('Saving...'),
            [SaveState.SAVED]: t('Saved')
        };

        this.saveRunLabels = {
            ...this.saveLabels,
            [SaveState.CHANGED]: t('Save and Run'),
        };

        this.initForm({
            onChange: (newState, key) => {
                const taskType = newState.formState.getIn(['data', 'type', 'value']);
                if (this.getTypeSpec(taskType).changedKeys.has(key)) {
                    newState.saveState = SaveState.CHANGED;
                }
            }
        });

        this.save = ::this.save
        this.changeJob = ::this.changeJob;
        this.toggleMaximized = ::this.toggleMaximized;
        this.toggleIntegration = ::this.toggleIntegration;
    }

    static propTypes = {
        entity: PropTypes.object.isRequired
    };

    changeJob(id) {
        if (this.state.jobId !== id) {
            this.closeRunEventSource();
            this.setState({
                run: null,
                runId: null,
                jobId: id
            });
        }
    }

    initRunEventSource(runId) {
        this.runOutputChunks = [];
        this.runEventSource = new EventSource(getUrl(`sse/jobs/${this.state.jobId}/run/${runId}`));
        this.runEventSource.addEventListener("changeRunStatus", (e) => {
            this.state.runStatus = e.data;
        });

        this.runEventSource.addEventListener("init", (e) => {
            const run = JSON.parse(e.data);

            this.setState({
                runStatus: run.status
            });
        });


        this.runEventSource.addEventListener("output", (e) => {
            if (e.origin + '/' !== getUrl()) {
                console.log(`Origin ${e.origin} not allowed; only events from ${getUrl()}`);
            } else {
                const data = JSON.parse(e.data);
                let counter = this.state.chunkCounter;
                if (Array.isArray(data)) {
                    data.forEach(d => {
                        this.runOutputChunks.push({
                            id: counter++,
                            data: d
                        });
                    })
                } else {
                    this.runOutputChunks.push({
                        id: counter++,
                        data: data
                    });
                }

                this.setState({
                    chunkCounter:counter
                });
            }
        });

        this.runEventSource.addEventListener("success", (e) => {
            this.setState({
                runStatus: RunStatus.SUCCESS
            });
            this.closeRunEventSource();
        });
        this.runEventSource.addEventListener("stop", (e) => {

            this.runOutputChunks.push({
                id: this.state.chunkCounter,
                data: `ERROR: Run has been stopped`
            });

            this.setState({
                runStatus: RunStatus.FAILED,
                chunkCounter: this.state.chunkCounter + 1
            });
            this.closeRunEventSource();
        });

        this.runEventSource.onmessage = function (e) {
            //console.log(e.data);
        }

        this.runEventSource.onerror = (e) => {
            console.log(e);
            this.runOutputChunks.push({
                id: this.state.chunkCounter,
                data: `ERROR: ${JSON.parse(e.data)}`
            });
            this.setState({
                chunkCounter: this.state.chunkCounter + 1
            });
            this.stop();
        };
    }

    @withAsyncErrorHandler
    async run() {
        if (this.state.jobId != null) {
            this.clearFormStatusMessage();
            const runIdData = await axios.post(getUrl(`rest/job-run/${this.state.jobId}`));
            const runId = runIdData.data;

            this.initRunEventSource(runId);

            this.setState({
                runStatus: RunStatus.INITIALIZATION,
                runId: runId,
                chunkCounter: 0
            });
        } else {
            this.setFormStatusMessage('warning', this.props.t('Job is not selected. Nothing to run.'));
        }
    }

    @withAsyncErrorHandler
    async stop() {
        if (this.state.runId) {
            await axios.post(getUrl(`rest/job-stop/${this.state.runId}`));

            this.closeRunEventSource();

            // FIXME this might cause race condition in the case job finishes on the server, at the same time
            // -- in that case this will be incorrect
            this.setState({
                runStatus: RunStatus.FAILED,
                runId: null
            });
        }
    }

    getTypeSpec(type) {
        const t = this.props.t;
        let spec = this.taskTypes[type];
        if (spec !== undefined) {
            return spec;
        }

        let editorMode = typeToEditor.get(type);
        if (editorMode === undefined) {
            editorMode = 'text';
        }

        spec = {
            changedKeys: new Set(['code', 'files', 'params']),
            tabs: [
                {
                    id: 'code',
                    default: true,
                    label: t('Code'),
                    getContent: () => <ACEEditor height={this.state.editorHeight + 'px'} id="code" mode={editorMode}
                                                 format="wide"/>
                },
                {
                    id: 'files',
                    label: t('Files'),
                    getContent: () => <Files entity={this.props.entity} entityTypeId="task" entitySubTypeId="file"
                                             managePermission="manageFiles"/>
                },
                {
                    id: 'params',
                    label: t('Parameters'),
                    getContent: () => <ACEEditor height={this.state.editorHeight + 'px'} id="params" mode="json"
                                                 format="wide"/>
                }
            ],
            dataIn: data => {
                data.code = data.settings.code;
                data.params = JSON.stringify(data.settings.params, null, '  ');
            },
            dataOut: data => {
                data.settings.code = data.code;
                data.settings.params = JSON.parse(data.params);
                delete data.code;
                delete data.params;
            },
            validate: state => {
                const paramsStr = state.getIn(['params', 'value']);
                try {
                    const params = JSON.parse(paramsStr);

                    if (!Array.isArray(params)) {
                        state.setIn(['params', 'error'], t('Parameters specification has to be a valid JSON array.'));
                    } else {
                        state.setIn(['params', 'error'], null);
                    }
                } catch (err) {
                    state.setIn(['params', 'error'], t('Parameters specification is not a valid JSON array. ') + err.message);
                }
            }
        };
        this.taskTypes[type] = spec;
        return spec;
    }

    getFormValuesMutator(data) {
        this.inputMutator(data);
    }

    inputMutator(data) {
        this.getTypeSpec(data.type).dataIn(data);
    }

    resizeTabPaneContent() {
        if (this.tabPaneContentNode) {
            let desiredHeight;
            const tabPaneContentNodeRect = this.tabPaneContentNode.getBoundingClientRect();

            if (this.state.isMaximized) {
                desiredHeight = window.innerHeight - tabPaneContentNodeRect.top;
            } else {
                // This number gives some space related to padding of the wrappers and size of the editor
                const calculatedHeight = window.innerHeight - tabPaneContentNodeRect.top - 53;
                desiredHeight = calculatedHeight < defaultEditorHeight ? defaultEditorHeight : calculatedHeight;
            }

            if (this.state.editorHeight !== desiredHeight) {
                this.setState({
                    editorHeight: desiredHeight
                });
            }
        }
    }

    componentDidMount() {
        this.getFormValuesFromEntity(this.props.entity);
        this.resizeTabPaneContent();
    }

    componentDidUpdate() {
        this.resizeTabPaneContent();
    }

    componentWillUnmount() {
        clearTimeout(this.runRefreshTimeout);
    }

    localValidateFormValues(state) {
        const taskType = state.getIn(['type', 'value']);
        this.getTypeSpec(taskType).validate(state);
    }

    async saveAndRun() {
        this.clearFormStatusMessage();
        await this.save();
        await this.run();
    }

    submitFormValuesMutator(data) {
        this.getTypeSpec(data.type).dataOut(data);
        return filterData(data, [
            'name',
            'description',
            'type',
            'settings',
            'namespace'
        ]);
    }

    closeRunEventSource() {
        if (this.runEventSource) {
            this.runEventSource.close();
            this.runEventSource = null;
        }
    }

    async save() {
        const t = this.props.t;

        const prevState = this.state.saveState;

        this.setState({
            saveState: SaveState.SAVING
        });

        this.disableForm();

        const submitSuccessful = await this.validateAndSendFormValuesToURL(FormSendMethod.PUT, `rest/tasks/${this.props.entity.id}`);

        if (submitSuccessful) {
            await this.getFormValuesFromURL(`rest/tasks/${this.props.entity.id}`);
            this.enableForm();
            this.setState({
                saveState: SaveState.SAVED,
                taskVersionId: this.state.taskVersionId + 1
            });
            this.clearFormStatusMessage();
            this.hideFormValidation();
        } else {
            this.enableForm();
            this.setState({
                saveState: prevState
            });

            this.setFormStatusMessage('warning', t('There are errors in the input. Please fix them and submit again.'));
        }
    }

    selectTab(tab) {
        this.setState({
            activeTab: tab
        });
    }

    toggleMaximized() {
        this.setState({isMaximized: !this.state.isMaximized});
    }

    toggleIntegration() {
        this.setState({withIntegration: !this.state.withIntegration});
    }

    render() {
        const t = this.props.t;
        const runStatus = this.state.runStatus;

        const statusMessageText = this.getFormStatusMessageText();
        const statusMessageSeverity = this.getFormStatusMessageSeverity();

        let activeTabContent;
        const tabs = [];

        const taskType = this.getFormValue('type');
        if (taskType) {
            for (const tabSpec of this.getTypeSpec(taskType).tabs) {
                const isActive = (!this.state.activeTab && tabSpec.default) || this.state.activeTab === tabSpec.id;

                tabs.push(
                    <li key={tabSpec.id} className={isActive ? 'active' : ''}>
                        <ActionLink className={'nav-link' + (isActive ? ' active' : '')}
                                    onClickAsync={() => this.selectTab(tabSpec.id)}>{tabSpec.label}</ActionLink>
                    </li>
                );

                if (isActive) {
                    activeTabContent = tabSpec.getContent();
                }
            }
        }


        const errors = [];
        for (const [key, entry] of this.state.formState.get('data').entries()) {
            const err = entry.get('error');
            if (err) {
                errors.push(<div key={key}>{err}</div>);
            }
        }

        const showStopBtn = (
            runStatus === RunStatus.INITIALIZATION ||
            runStatus === RunStatus.RUNNING ||
            runStatus === RunStatus.SCHEDULED
        );

        let saveAndRunBtn = null;
        if (this.state.saveState === SaveState.SAVED) {
            saveAndRunBtn =
                <Button className="btn-primary"
                        label={t('Run')}
                        onClickAsync={() => this.run()}/>
        } else if (this.state.saveState === SaveState.CHANGED) {
            saveAndRunBtn = <Button className="btn-primary"
                                    label={this.saveRunLabels[this.state.saveState]}
                                    onClickAsync={() => this.saveAndRun()}/>
        }

        return (
            <Panel title={t('Edit Task Code')}>
                <div
                    className={developStyles.develop + ' ' + (this.state.isMaximized ? developStyles.fullscreenOverlay : '') + ' ' + (this.state.withIntegration ? developStyles.withIntegration : '')}>
                    <div className={developStyles.codePane}>
                        <Form stateOwner={this} onSubmitAsync={this.save} format="wide" noStatus>
                            <div className={developStyles.tabPane}>
                                <div id="headerPane" className={developStyles.tabPaneHeader}>
                                    <div className={developStyles.buttons}>

                                        <Button type="submit" className="btn-primary"
                                                label={this.saveLabels[this.state.saveState]}/>
                                        {!showStopBtn && saveAndRunBtn}
                                        {showStopBtn &&
                                        <Button className="btn-primary"
                                                label={t('Stop')}
                                                onClickAsync={() => this.stop()}/>
                                        }
                                        <Button className="btn-primary"
                                                icon={this.state.isMaximized ? "compress-arrows-alt" : "expand-arrows-alt"}
                                                onClickAsync={this.toggleMaximized}/>
                                        <Button className="btn-primary"
                                                icon={this.state.withIntegration ? 'arrow-right' : 'arrow-left'}
                                                onClickAsync={this.toggleIntegration}/>
                                    </div>
                                    <ul className="nav nav-pills">
                                        {tabs}
                                    </ul>
                                </div>

                                <div className={developStyles.formStatus}>
                                    {statusMessageText &&
                                    <div id="form-status-message"
                                         className={`alert alert-${statusMessageSeverity}`}
                                         role="alert">{statusMessageText}</div>
                                    }
                                    {errors.length > 0 && this.isFormValidationShown() &&
                                    <div id="form-status-message"
                                         className={`alert alert-danger`}
                                         role="alert">
                                        {errors}
                                    </div>
                                    }
                                </div>

                                <div ref={node => this.tabPaneContentNode = node}
                                     className={developStyles.tabPaneContent}>
                                    {activeTabContent}
                                </div>
                            </div>
                        </Form>
                    </div>
                    <div className={developStyles.integrationPane}>
                        <IntegrationTabs onJobChange={this.changeJob} taskId={this.props.entity.id}
                                         taskHash={this.state.taskVersionId} runStatus={this.state.runStatus}
                                         lastOutputChunkId={this.state.chunkCounter}
                                         runOutputChunks={this.runOutputChunks}/>

                    </div>
                </div>
            </Panel>
        );
    }
}
