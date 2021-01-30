'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {LinkButton, requiresAuthenticatedUser, withPageHelpers} from "../../lib/page";
import {
    Button,
    ButtonRow,
    Dropdown,
    Fieldset,
    filterData,
    Form,
    FormSendMethod,
    InputField, ListCreator, StaticField,
    TableSelect,
    TextArea,
    withForm,
    withFormErrorHandlers
} from "../../lib/form";
import "brace/mode/json";
import "brace/mode/jsx";
import "brace/mode/scss";
import {withAsyncErrorHandler, withErrorHandling} from "../../lib/error-handling";
import {NamespaceSelect, validateNamespace} from "../../lib/namespace";
import {DeleteModalDialog} from "../../lib/modals";
import {Panel} from "../../lib/panel";
import ivisConfig from "ivisConfig";
import {getJobStates} from './states';
import {JobState} from "../../../../shared/jobs";
import moment from "moment";
import ParamTypes from "../ParamTypes"
import axios from '../../lib/axios';
import {getUrl} from "../../lib/urls";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import {TaskSource} from "../../../../shared/tasks"

import {
    fetchBuiltinTasks
} from "../../lib/builtin-tasks";

@withComponentMixins([
    withTranslation,
    withForm,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class CUD extends Component {
    constructor(props) {
        super(props);

        this.state = {
            builtinTasks: null
        };

        this.initForm({
            onChangeBeforeValidation: ::this.onChangeBeforeValidation,
            onChange: {
                task: ::this.onTaskChange,
                taskSource: ::this.onTaskChange
            }
        });

        this.paramTypes = new ParamTypes(props.t);
    }

    static propTypes = {
        action: PropTypes.string.isRequired,
        entity: PropTypes.object
    };

    @withAsyncErrorHandler
    async fetchTaskParams(taskId) {
        const result = await axios.get(getUrl(`rest/task-params/${taskId}`));

        this.updateFormValue('taskParams', result.data);
    }

    getDefaultBuiltinTask() {
        return (this.state.builtinTasks && this.state.builtinTasks.length > 0) ? this.state.builtinTasks[0] : null;
    }

    componentDidMount() {
        if (this.props.entity) {
            this.getFormValuesFromEntity(this.props.entity);
        } else {
            this.populateFormValues({
                name: '',
                description: '',
                namespace: ivisConfig.user.namespace,
                task: null,
                taskSource: TaskSource.USER,
                state: JobState.ENABLED,
                signal_sets_triggers: [],
                trigger: '',
                min_gap: '',
                delay: ''
            });
        }

        fetchBuiltinTasks().then(tasks => this.setState({builtinTasks: tasks}));
    }

    onTaskChange(state, key, oldVal, newVal) {
        if (oldVal !== newVal) {
            const taskSource = state.formState.getIn(['data', 'taskSource', 'value']);

            const taskId = state.formState.getIn(['data', 'task', 'value']);
            if (taskSource === TaskSource.USER) {
                state.formState = state.formState.setIn(['data', 'taskParams', 'value'], '');

                if (taskId) {
                    this.fetchTaskParams(taskId);
                }
            } else {
                const builtinTask = this.state.builtinTasks && this.state.builtinTasks.find(task => task.id == taskId);

                if (builtinTask) {
                    state.formState = state.formState.setIn(['data', 'taskParams', 'value'], builtinTask.settings.params);
                } else {
                    const defaultTask = this.getDefaultBuiltinTask();
                    state.formState = state.formState.setIn(['data', 'task', 'value'], defaultTask.id);
                    state.formState = state.formState.setIn(['data', 'taskParams', 'value'], defaultTask.settings.params);
                }
            }
        }
    }

    onChangeBeforeValidation(mutStateData, key, oldVal, newVal) {
        if (key === 'taskParams') {
            if (oldVal !== newVal && newVal) {
                this.paramTypes.adopt(newVal, mutStateData);
            }
        } else {
            const configSpec = mutStateData.getIn(['taskParams', 'value']);
            if (configSpec) {
                this.paramTypes.onChange(configSpec, mutStateData, key, oldVal, newVal)
            }
        }
    }

    static isPositiveInteger(s) {
        return /^[1-9][\d]*$/.test(s);
    }


    localValidateFormValues(state) {
        const t = this.props.t;

        if (!state.getIn(['name', 'value'])) {
            state.setIn(['name', 'error'], t('Name must not be empty'));
        } else {
            state.setIn(['name', 'error'], null);
        }


        if (!state.getIn(['task', 'value'])) {
            state.setIn(['task', 'error'], t('Task must be selected'));
        } else {
            state.setIn(['task', 'error'], null);
        }

        const trigger = state.getIn(['trigger', 'value']);
        if (trigger) {
            if (!CUD.isPositiveInteger(trigger)) {
                state.setIn(['trigger', 'error'], t('Trigger must be positive integer'));
            } else {
                state.setIn(['trigger', 'error'], null);
            }
        } else {
            state.setIn(['trigger', 'error'], null);
        }

        let delay = state.getIn(['delay', 'value']);
        if (delay) {
            if (!CUD.isPositiveInteger(delay)) {
                state.setIn(['delay', 'error'], t('Delay must be positive integer'));
            } else {
                state.setIn(['delay', 'error'], null);
            }
        } else {
            state.setIn(['delay', 'error'], null);
        }

        const min_gap = state.getIn(['min_gap', 'value']);
        if (min_gap) {
            if (!CUD.isPositiveInteger(min_gap)) {
                state.setIn(['min_gap', 'error'], t('Minimal interval must be positive integer'));
            } else {
                state.setIn(['min_gap', 'error'], null);
            }
        } else {
            state.setIn(['min_gap', 'error'], null);
        }

        const paramPrefix = this.paramTypes.getParamPrefix();
        for (const paramId of state.keys()) {
            if (paramId.startsWith(paramPrefix)) {
                state.deleteIn([paramId, 'error']);
            }
        }

        const configSpec = state.getIn(['taskParams', 'value']);
        if (configSpec) {
            this.paramTypes.localValidate(configSpec, state);
        }

        validateNamespace(t, state);
    }

    getFormValuesMutator(data) {
        this.paramTypes.setFields(data.taskParams, data.params, data);

        if (data['state'] === JobState.INVALID_PARAMS) {
            data['state'] = JobState.DISABLED;
        }

    }

    submitFormValuesMutator(data) {
        if (this.props.entity) {
            data.settings = this.props.entity.settings;
        }

        ListCreator.submitFormValuesMutator('signalSetTriggers', data);
        data.signal_sets_triggers = data.signalSetTriggers;

        data.params = {};
        if (data.taskParams) {
            data.params = this.paramTypes.getParams(data.taskParams, data);
        }

        return filterData(data, [
            'name',
            'description',
            'task',
            'params',
            'state',
            'trigger',
            'min_gap',
            'delay',
            'namespace',
            'signal_sets_triggers',
        ]);
    }

    @withFormErrorHandlers
    async submitHandler(submitAndLeave) {
        const t = this.props.t;

        if (this.getFormValue('task') && !this.getFormValue('taskParams')) {
            this.setFormStatusMessage('warning', t('Task parameters are not selected. Wait for them to get displayed and then fill them in.'));
            return;
        }

        let sendMethod, url;
        if (this.props.entity) {
            sendMethod = FormSendMethod.PUT;
            url = `rest/jobs/${this.props.entity.id}`
        } else {
            sendMethod = FormSendMethod.POST;
            url = 'rest/jobs'
        }

        try {
            this.disableForm();
            this.setFormStatusMessage('info', t('Saving ...'));

            const submitResult = await this.validateAndSendFormValuesToURL(sendMethod, url);


            if (submitResult) {
                if (this.props.entity) {
                    if (submitAndLeave) {
                        this.navigateToWithFlashMessage('/settings/jobs', 'success', t('Job updated'));
                    } else {
                        await this.getFormValuesFromURL(`rest/jobs/${this.props.entity.id}`);
                        this.enableForm();
                        this.setFormStatusMessage('success', t('Job updated'));
                    }
                } else {
                    if (submitAndLeave) {
                        this.navigateToWithFlashMessage('/settings/jobs', 'success', t('Job saved'));
                    } else {
                        this.navigateToWithFlashMessage(`/settings/jobs/${submitResult}/edit`, 'success', t('Job saved'));
                    }
                }
            } else {
                this.enableForm();
                this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and submit again.'));
            }
        } catch (error) {
            throw error;
        }
    }

    static getStateOptions(t) {
        let states = getJobStates(t);
        const stateOptions = [];
        for (let key in states) {
            if (key != JobState.INVALID_PARAMS) {
                if (states.hasOwnProperty(key)) {
                    stateOptions.push({key: key, label: states[key]})
                }
            }
        }

        return stateOptions;
    }

    render() {
        const t = this.props.t;
        const isEdit = !!this.props.entity;
        const canDelete = isEdit && this.props.entity.permissions.includes('delete');

        let stateOptions = CUD.getStateOptions(t);

        const setsColumns = [
            {data: 1, title: t('#')},
            {data: 2, title: t('Name')},
            {data: 3, title: t('Description')},
        ];


        const signal_sets_triggers = this.getFormValue('signal_sets_triggers') || [];

        const taskColumns = [
            {data: 1, title: t('Name')},
            {data: 2, title: t('Description')},
            {data: 4, title: t('Created'), render: data => moment(data).fromNow()}
        ];

        const configSpec = this.getFormValue('taskParams');
        const params = configSpec ? this.paramTypes.render(configSpec, this) : null;

        const taskSourceOptions = [
            {key: TaskSource.USER, label: t('User-defined task')},
            {key: TaskSource.BUILTIN, label: t('Built-in task')},
        ];

        const builtinTaskOptions = [];
        if (this.state.builtinTasks) {
            for (const task of this.state.builtinTasks) {
                builtinTaskOptions.push({key: task.id, label: t(task.name)});
            }
        }

        return (
            <Panel title={isEdit ? t('Job Settings') : t('Create Job')}>
                {canDelete &&
                <DeleteModalDialog
                    stateOwner={this}
                    visible={this.props.action === 'delete'}
                    deleteUrl={`rest/jobs/${this.props.entity.id}`}
                    backUrl={`/settings/jobs/${this.props.entity.id}/edit`}
                    successUrl="/settings/jobs"
                    deletingMsg={t('Deleting job ...')}
                    deletedMsg={t('Job deleted')}/>
                }

                <Form stateOwner={this} onSubmitAsync={::this.submitHandler}>
                    <InputField id="name" label={t('Name')}/>
                    <TextArea id="description" label={t('Description')} help={t('HTML is allowed')}/>


                    {this.state.builtinTasks ? (
                        this.state.builtinTasks.length > 0 &&
                        <Dropdown id="taskSource" label={t('Task source')} options={taskSourceOptions}
                                  disabled={isEdit}/>
                    ) : (
                        <StaticField id={'taskSource'}>Loading...</StaticField>
                    )
                    }

                    {this.getFormValue('taskSource') === TaskSource.USER ?
                        <TableSelect id="task" label={t('Task')} withHeader dropdown dataUrl="rest/tasks-table"
                                     columns={taskColumns} selectionLabelIndex={1} disabled={isEdit}/>
                        :
                        <Dropdown id="task" label={t('Task')} options={builtinTaskOptions} disabled={isEdit}/>
                    }

                    <Dropdown id="state" label={t('State')} options={stateOptions}/>
                    <NamespaceSelect/>
                    <Fieldset id="triggers" label={t('Triggers')}>
                        <InputField id="trigger" label={t('Periodic trigger')}
                                    placeholder="Automatic trigger time in seconds"/>
                        <InputField id="min_gap" label={t('Minimal interval')}
                                    placeholder="Minimal time between runs in seconds"/>
                        <InputField id="delay" label={t('Delay')} placeholder="Delay before triggering in seconds"/>
                    </Fieldset>

                    <ListCreator
                        id={'signalSetTriggers'}
                        label={t('Signal sets triggers')}
                        entryElement={
                            <TableSelect
                                label={t('Trigger on')}
                                withHeader
                                dropdown
                                dataUrl='rest/signal-sets-table'
                                columns={setsColumns}
                                selectionLabelIndex={2}
                            />
                        }
                        initValues={signal_sets_triggers}
                    />

                    {configSpec ?
                        params &&
                        <Fieldset label={t('Task parameters')}>
                            {params}
                        </Fieldset>
                        :
                        this.getFormValue('task') &&
                        <div className="alert alert-info" role="alert">{t('Loading task...')}</div>
                    }

                    <ButtonRow>
                        <Button type="submit" className="btn-primary" icon="check" label={t('Save')}/>
                        <Button type="submit" className="btn-primary" icon="check" label={t('Save and leave')}
                                onClickAsync={async () => await this.submitHandler(true)}/>
                        {canDelete &&
                        <LinkButton
                            className="btn-danger"
                            icon="trash-alt"
                            label={t('Delete')}
                            to={`/settings/jobs/${this.props.entity.id}/delete`}
                        />}
                    </ButtonRow>
                </Form>
            </Panel>
        );
    }
}
