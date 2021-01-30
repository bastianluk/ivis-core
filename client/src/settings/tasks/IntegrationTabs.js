'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {Form, TableSelect, withForm} from "../../lib/form";
import {requiresAuthenticatedUser, withPageHelpers} from "../../lib/page";
import {withAsyncErrorHandler, withErrorHandling} from "../../lib/error-handling";
import outputStyles from "./Output.scss";
import developStyles from "./Develop.scss";
import axios from "../../lib/axios";
import {BuildState} from "../../../../shared/tasks"
import {getUrl} from "../../lib/urls";
import {RunStatus} from "../../../../shared/jobs";
import {ActionLink} from "../../lib/bootstrap-components";
import moment from "moment";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";

const Span = props=> <span>{props.data}</span>

@withComponentMixins([
    withTranslation,
    withForm,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class IntegrationTabs extends Component {
    static propTypes = {
        taskId: PropTypes.number,
        taskHash: PropTypes.number,
        withBuild: PropTypes.bool,
        onJobChange: PropTypes.func,
        runOutputChunks: PropTypes.array,
        lastOutputChunkId: PropTypes.number,
        runStatus: PropTypes.number
    };

    constructor(props) {
        super(props);

        this.state = {
            activeTab: null,
            task: null,
            prevPropsTaskHash: this.props.taskHash
        };
        this.refreshTimeout = null;
        this.initForm();
        this.initForm({
            onChange: (newState) => {
                this.props.onJobChange(newState.formState.getIn(['data', 'developJob', 'value']));
            }
        });


        const t = props.t;
        this.jobColumns = [
            {data: 0, title: t('#')},
            {data: 1, title: t('Name')},
            {data: 2, title: t('Description')},
            {data: 4, title: t('Created'), render: data => moment(data).fromNow()},
            {data: 5, title: t('Namespace')}
        ];

    }

    @withAsyncErrorHandler
    async fetchTask() {
        const result = await axios.get(getUrl(`rest/tasks/${this.props.taskId}`));

        const task = result.data;

        this.setState({
            task: task
        });

    if (task.build_state == null
            || task.build_state === BuildState.SCHEDULED
            || task.build_state === BuildState.PROCESSING) {
            this.refreshTimeout = setTimeout(() => {
                this.fetchTask();
            }, 1000);
        }
    }

    componentDidMount() {
        this.populateFormValues({
            developJob: null
        });

        if (!this.state.task) {
            this.fetchTask();
        }
    }

    shouldComponentUpdate(nextProps, nextState) {
        return nextProps.taskHash !== this.props.taskHash ||
            this.state.task !== nextState.task ||
            this.state.jobId !== nextState.jobId ||
            this.state.runId !== nextState.runId ||
            this.props.runOutputChunks !== nextProps.runOutputChunks ||
            this.props.lastOutputChunkId !== nextProps.lastOutputChunkId ||
            this.props.runStatus !== nextProps.runStatus ||
            this.state.activeTab !== nextState.activeTab ||
            this.state.formState !== nextState.formState

    }


    componentWillUnmount() {
        clearTimeout(this.refreshTimeout);
    }

    static getDerivedStateFromProps(nextProps, prevState) {
        if (nextProps.taskHash !== prevState.prevPropsTaskHash) {
            return {
                prevPropsTaskHash: nextProps.taskHash,
                task: null
            };
        }
    }

    componentDidUpdate() {
        if (!this.state.task) {
            this.fetchTask();
        }
    }

    selectTab(tab) {
        this.setState({
            activeTab: tab
        });
    }

    getBuildContent(t) {
        const task = this.state.task;
        let buildContent = null;
        if (!task) {
            buildContent = (
                <div>{t('Loading...')}</div>
            );

        } else {
            switch (task.build_state) {
                case (BuildState.SCHEDULED):
                case (BuildState.PROCESSING):
                    buildContent = (
                        <div>{t('Building task...')}</div>
                    );
                    break;
                case (BuildState.FAILED):
                    if (task.build_output) {
                        const errors = [];
                        const warnings = [];

                        let
                            idx = 0;
                        if (task.build_output.errors) {
                            for (const error of task.build_output.errors
                                ) {
                                errors.push(<div key={idx}>{error}</div>);
                                idx++;
                            }
                        }

                        if (task.build_output.warnings) {
                            for (const warning of task.build_output.warnings) {
                                warnings.push(<div key={idx}>{warning}</div>);
                                idx++;
                            }
                        }

                        buildContent = (
                            <>
                                {errors.length > 0 &&
                                <div>
                                    <div className={outputStyles.label}>{t('Errors:')}</div>
                                    {errors}
                                </div>
                                }

                                {warnings.length > 0 &&
                                <div>
                                    <div className={outputStyles.label}>{t('Warnings:')}</div>
                                    {warnings}
                                </div>
                                }
                            </>
                        );
                    } else {
                        buildContent = (
                            <div className={outputStyles.label}>{t('Build failed')}</div>
                        );
                    }
                    break;

                case (BuildState.FINISHED):
                    const warnings = [];
                    let idx = 0;
                    if (task.build_output && task.build_output.warnings && task.build_output.warnings.length > 0) {
                        for (const warning of task.build_output.warnings) {
                            warnings.push(<div key={idx}>{warning}</div>);
                            idx++;
                        }

                        buildContent = (
                            <div>
                                <div className={outputStyles.label}>{t('Warnings:')}</div>
                                {warnings}
                            </div>
                        )
                    } else {
                        buildContent = (
                            <div className={outputStyles.label}>{t('Build successful')}</div>
                        );
                    }
                    break;
                default:
                    buildContent = (
                        <div className={outputStyles.label}>{t('Task is not build.')}</div>
                    );
                    break;
            }
        }

        return (
            <div className={developStyles.integrationTab}>
                <div className={developStyles.integrationTabRunOutput}>
                    {buildContent}
                </div>
            </div>
        );
    }

    getRunContent(t) {
        let runStatusElement = null;
        const status = this.props.runStatus;


        if (status == null) {
            runStatusElement = (
                <div className='p-1 text-info'>{t('Not run in this panel yet.')}</div>
            );
        } else {
            switch (status) {
                case (RunStatus.INITIALIZATION):
                case (RunStatus.SCHEDULED):
                    runStatusElement = (
                        <div className='p-1 text-info'>{t('Loading...')}</div>
                    );
                    break;
                case (RunStatus.RUNNING):
                    runStatusElement = (
                        <div className='p-1 text-info'>{t('Running...')}</div>
                    );
                    break;
                case (RunStatus.FAILED):
                    runStatusElement = (
                        <div className='p-1 text-danger'>{t('Finished with error')}</div>
                    );
                    break;
                case (RunStatus.SUCCESS):
                    runStatusElement = (
                        <div className='p-1 text-success'>{t('Finished successfully')}</div>
                    );
                    break;
            }

        }

        let runOutput = '';
        if (this.props.runOutputChunks && (this.props.runOutputChunks.length > 0)) {
            runOutput = this.props.runOutputChunks.map((output) => {
                //return <span key={output.id}>{output.data}</span>;
                return <Span key={output.id} data={output.data}/>;
            });
        } else if (status && status.output) {
            runOutput = status.output;
        }

        return (
            <div className={developStyles.integrationTab}>
                <div className={developStyles.integrationTabHeader}>
                    <Form stateOwner={this} format="wide" noStatus>
                        <TableSelect id="developJob" label={t('Job for testing')} format="wide" withHeader dropdown
                                     dataUrl={`rest/jobs-by-task-table/${this.props.taskId}`} columns={this.jobColumns}
                                     selectionLabelIndex={1}/>
                    </Form>
                </div>
                <div className={developStyles.integrationTabRunStatus}>
                    {runStatusElement}
                </div>
                <div className={developStyles.integrationTabRunOutput}>
                    <pre>
                        <code>
                            {runOutput}
                        </code>
                    </pre>
                </div>
            </div>
        );
    }

    render() {
        const t = this.props.t;
        let buildContent = null;
        let runContent = null;

        buildContent = this.getBuildContent(t);

        runContent = this.getRunContent(t);

        const tabs = [
            {
                id: 'run',
                default: true,
                label: t('Run'),
                getContent: () => runContent
            },
            {
                id: 'build',
                label: t('Build'),
                getContent: () => buildContent
            }
        ];

        let activeTabContent;
        const developTabs = [];
        for (const tabSpec of tabs) {
            const isActive = (!this.state.activeTab && tabSpec.default) || this.state.activeTab === tabSpec.id;

            developTabs.push(
                <li key={tabSpec.id} className={isActive ? 'active' : ''}>
                    <ActionLink className={'nav-link' + (isActive ? ' active' : '')}
                                onClickAsync={() => this.selectTab(tabSpec.id)}>{tabSpec.label}</ActionLink>
                </li>
            );

            if (isActive) {
                activeTabContent = tabSpec.getContent();
            }
        }


        return (
            <>
                <div id="headerPreviewPane" className={developStyles.integrationPaneHeader}>
                    <ul className="nav nav-pills">
                        {developTabs}
                    </ul>
                </div>
                {activeTabContent}
            </>
        );
    }
}
