'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {translate} from "react-i18next";
import {LinkButton, requiresAuthenticatedUser, withPageHelpers} from "../../lib/page";
import {
    Button,
    ButtonRow,
    Dropdown, filterData,
    Form,
    FormSendMethod,
    InputField,
    TextArea,
    withForm, withFormErrorHandlers
} from "../../lib/form";
import "brace/mode/json";
import "brace/mode/jsx";
import "brace/mode/scss";
import {withAsyncErrorHandler, withErrorHandling} from "../../lib/error-handling";
import {NamespaceSelect, validateNamespace} from "../../lib/namespace";
import {DeleteModalDialog} from "../../lib/modals";
import {Panel} from "../../lib/panel";
import ivisConfig from "ivisConfig";
import {WizardType, getWizard, getWizardsForType} from "./wizards";
import {TaskType, subtypesByType} from "../../../../shared/tasks";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import {getSubtypeLabel} from "./types";

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withForm,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class CUD extends Component {
    constructor(props) {
        super(props);

        this.state = {};

        this.initForm();
        this.submitHandler = ::this.submitHandler;
    }

    static propTypes = {
        action: PropTypes.string.isRequired,
        entity: PropTypes.object
    };

    componentDidMount() {
        if (this.props.entity) {
            this.getFormValuesFromEntity(this.props.entity);
        } else {
            this.populateFormValues({
                name: '',
                description: '',
                namespace: ivisConfig.user.namespace,
                type: TaskType.PYTHON,
                subtype: '',
                wizard: WizardType.BLANK
            });
        }
    }

    getFormValuesMutator(data) {
        data.subtype = data.settings.subtype ? data.settings.subtype : null;
    }

    localValidateFormValues(state) {
        const t = this.props.t;

        if (!state.getIn(['name', 'value'])) {
            state.setIn(['name', 'error'], t('Name must not be empty'));
        } else {
            state.setIn(['name', 'error'], null);
        }

        if (!state.getIn(['type', 'value'])) {
            state.setIn(['type', 'error'], t('Type must be selected'));
        } else {
            state.setIn(['type', 'error'], null);
        }


        validateNamespace(t, state);
    }

    submitFormValuesMutator(data) {
        if (!this.props.entity) {
            const wizardData = getWizard(data.type, data.subtype, data.wizard);
            if (wizardData) {
                wizardData.wizard(data);
            } else {
                data.settings = {
                    params: [],
                    code: ''
                };
            }

            if (data.subtype) {
                data.settings.subtype = data.subtype;
            }
        } else {
            data.settings = this.props.entity.settings;
        }


        return filterData(data, [
            'name',
            'description',
            'type',
            'settings',
            'namespace'
        ]);
    }

    @withFormErrorHandlers
    async submitHandler(submitAndLeave) {
        const t = this.props.t;

        let sendMethod, url;
        if (this.props.entity) {
            sendMethod = FormSendMethod.PUT;
            url = `rest/tasks/${this.props.entity.id}`
        } else {
            sendMethod = FormSendMethod.POST;
            url = 'rest/tasks'
        }

        this.disableForm();
        this.setFormStatusMessage('info', t('Saving ...'));

        const submitResult = await this.validateAndSendFormValuesToURL(sendMethod, url);


        if (submitResult) {
            if (this.props.entity) {
                if (submitAndLeave) {
                    this.navigateToWithFlashMessage('/settings/tasks', 'success', t('Task updated'));
                } else {
                    await this.getFormValuesFromURL(`rest/tasks/${this.props.entity.id}`);
                    this.enableForm();
                    this.setFormStatusMessage('success', t('Task updated'));
                }
            } else {
                if (submitAndLeave) {
                    this.navigateToWithFlashMessage('/settings/tasks', 'success', t('Task saved'));
                } else {
                    this.navigateToWithFlashMessage(`/settings/tasks/${submitResult}/edit`, 'success', t('Task saved'));
                }
            }
        } else {
            this.enableForm();
            this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and submit again.'));
        }
    }

    render() {
        const t = this.props.t;
        const isEdit = !!this.props.entity;
        const canDelete = isEdit && this.props.entity.permissions.includes('delete');

        const typeOptions = [
            {key: TaskType.PYTHON, label: t('Python')},
        ];

        const taskType = this.getFormValue('type');

        const wizardOptions = [];
        const subtypeOptions = [];

        // Subtypes
        const subtypes = taskType ? subtypesByType[taskType] : null;
        if (subtypes) {

            // Default option
            subtypeOptions.push({
                key: null,
                label: ''
            });

            Object.values(subtypes).forEach((subtype) => {
                subtypeOptions.push({
                    key: subtype,
                    label: getSubtypeLabel(t, taskType, subtype)
                });
            });
        }

        if (!isEdit && taskType) {
            const subtype = this.getFormValue('subtype');
            const wizardsForType = getWizardsForType(taskType, subtype);
            if (wizardsForType) {
                Object.entries(wizardsForType).forEach((entry) => {
                    wizardOptions.push({
                        key: entry[0],
                        label: t(entry[1].label)
                    });
                });
            }


        }

        return (
            <Panel title={isEdit ? t('Task Settings') : t('Create Task')}>
                {canDelete &&
                <DeleteModalDialog
                    stateOwner={this}
                    visible={this.props.action === 'delete'}
                    deleteUrl={`rest/tasks/${this.props.entity.id}`}
                    backUrl={`/settings/tasks/${this.props.entity.id}/edit`}
                    successUrl="/settings/tasks"
                    deletingMsg={t('Deleting task ...')}
                    deletedMsg={t('Task deleted')}/>
                }

                <Form stateOwner={this} onSubmitAsync={this.submitHandler}>
                    <InputField id="name" label={t('Name')}/>
                    <TextArea id="description" label={t('Description')} help={t('HTML is allowed')}/>
                    <Dropdown id="type" label={t('Type')} options={typeOptions} disabled={isEdit}/>
                    {taskType &&
                    <Dropdown id="subtype" label={t('Subtype')} options={subtypeOptions} disabled={isEdit}/>}

                    {!isEdit && <Dropdown id="wizard" label={t('Wizard')} options={wizardOptions}/>}
                    <NamespaceSelect/>

                    <ButtonRow>
                        <Button type="submit" className="btn-primary" icon="ok" label={t('Save')}/>
                        <Button type="submit" className="btn-primary" icon="check" label={t('Save and leave')}
                                onClickAsync={async () => await this.submitHandler(true)}/>
                        {canDelete && <LinkButton className="btn-danger" icon="remove" label={t('Delete')}
                                                  to={`/settings/tasks/${this.props.entity.id}/delete`}/>}
                    </ButtonRow>
                </Form>
            </Panel>
        );
    }
}
