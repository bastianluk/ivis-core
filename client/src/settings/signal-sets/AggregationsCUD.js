'use strict';

import React, {Component} from "react";
import PropTypes
    from "prop-types";
import {
    LinkButton,
    requiresAuthenticatedUser,
    withPageHelpers
} from "../../lib/page";
import {
    Button,
    ButtonRow,
    DateTimePicker,
    filterData,
    Form,
    FormSendMethod,
    InputField,
    TableSelect,
    TableSelectMode,
    withForm,
    withFormErrorHandlers
} from "../../lib/form";
import {withErrorHandling} from "../../lib/error-handling";
import {DeleteModalDialog} from "../../lib/modals";
import {Panel} from "../../lib/panel";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import {getSignalTypes} from "../signal-sets/signals/signal-types.js";
import moment from "moment";
import interoperableErrors from "../../../../shared/interoperable-errors";
import {isSignalSetAggregationIntervalValid} from "../../../../shared/validators"

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
        const t = props.t;

        this.state = {};

        this.initForm();

    }

    static propTypes = {
        action: PropTypes.string.isRequired,
        signalSet: PropTypes.object,
        job: PropTypes.object,
    };


    componentDidMount() {
        const props = this.props;

        if (props.job) {
            this.populateFormValues({
                ts: props.job.params.ts,
                interval: props.job.params.interval,
                offset: props.job.params.offset || ''
            });
        } else {
            const ts = props.signalSet.settings && props.signalSet.settings.ts;

            this.populateFormValues({
                    ts: ts,
                    interval: '',
                    offset: ''
                }
            )
        }
    }


    localValidateFormValues(state) {
        const t = this.props.t;

        if (!state.getIn(['ts', 'value'])) {
            state.setIn(['ts', 'error'], t('Timestamp signal must not be empty'));
        } else {
            state.setIn(['ts', 'error'], null);
        }

        const intervalStr = state.getIn(['interval', 'value']).trim();
        if (!intervalStr) {
            state.setIn(['interval', 'error'], t('Interval must not be empty'));
        } else {
            if (!isSignalSetAggregationIntervalValid(intervalStr)) {
                state.setIn(['interval', 'error'], t('Interval must be a positive integer and have a unit.'));
            } else {
                state.setIn(['interval', 'error'], null);
            }
        }

        const offset = state.getIn(['offset', 'value']);
        if (offset) {
            if (!this.parseDateTime(offset)) {
                state.setIn(['offset', 'error'], t('Offset format is "YYYY-MM-DD hh:mm:ss"'));
            } else {
                state.setIn(['offset', 'error'], null);
            }
        } else {
            state.setIn(['offset', 'error'], null);
        }
    }

    submitFormValuesMutator(data) {

        data.interval = data.interval.trim();
        data.offset = data.offset.trim() ? data.offset : null;

        const allowedKeys = [
            'interval',
            'ts',
            'offset'
        ];

        return filterData(data, allowedKeys);
    }

    @withFormErrorHandlers
    async submitHandler(submitAndLeave) {
        const t = this.props.t;

        let sendMethod, url;
        if (this.props.entity) {
            sendMethod = FormSendMethod.PUT;
            url = `rest/signal-sets/${this.props.signalSet.id}/aggregations`
        } else {
            sendMethod = FormSendMethod.POST;
            url = `rest/signal-sets/${this.props.signalSet.id}/aggregations`
        }

        this.disableForm();
        this.setFormStatusMessage('info', t('Saving ...'));

        const submitResult = await this.validateAndSendFormValuesToURL(sendMethod, url);

        if (submitResult) {

            if (this.props.job) {
                this.navigateBack();
            } else {
                if (submitAndLeave) {
                    M
                    this.navigateToWithFlashMessage(`/settings/signal-sets/${this.props.signalSet.id}/aggregations`, 'success', t('Aggregation created'));
                } else {
                    this.navigateToWithFlashMessage(`/settings/signal-sets/${this.props.signalSet.id}/aggregations/${submitResult}/edit`, 'success', t('Aggregation created'));
                }
            }
        } else {
            this.enableForm();
            this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and submit again.'));
        }
    }

    errorHandler(error) {
        if (error instanceof interoperableErrors.ServerValidationError) {
            this.enableForm();
            this.setFlashMessage('danger', `Creation failed - ${error.message}`);
            this.clearFormStatusMessage();
            return true;
        }
    }

    parseDateTime = str => {
        const date = moment(str, 'YYYY-MM-DD HH:mm:ss', true);
        if (date && date.isValid()) {
            return date.toDate();
        } else {
            return null;
        }
    };

    render() {
        const t = this.props.t;
        const signalSet = this.props.signalSet;
        const aggJob = this.props.job;
        const isEdit = !!aggJob;
        const canDelete = isEdit && this.props.job.permissions.includes('delete');


        const signalTypes = getSignalTypes(t);
        const signalColumns = [
            {data: 1, title: t('Id')},
            {data: 2, title: t('Name')},
            {data: 3, title: t('Description')},
            {data: 4, title: t('Type'), render: data => signalTypes[data]},
        ];

        const isSignalsetTimeseries = signalSet.settings && signalSet.settings.ts;

        return (
            <Panel title={isEdit ? t('Edit Aggregation') : t('Create Aggregation')}>
                {canDelete &&
                <DeleteModalDialog
                    stateOwner={this}
                    name={aggJob.name}
                    visible={this.props.action === 'delete'}
                    deleteUrl={`rest/jobs/${aggJob.id}`}
                    backUrl={`/settings/signal-sets/${signalSet.id}/aggregations/${aggJob.id}/edit`}
                    successUrl={`/settings/signal-sets/${signalSet.id}/aggregations`}
                    deletingMsg={t('Deleting aggregation...')}
                    deletedMsg={t('Aggregation deleted')}/>
                }

                <Form stateOwner={this} onSubmitAsync={::this.submitHandler}>

                    <TableSelect
                        key="ts"
                        id="ts"
                        label={t("Timestamp signal")}
                        help={t("Timestamp signal that aggregations is based on")}
                        columns={signalColumns}
                        withHeader
                        dropdown
                        selectMode={TableSelectMode.SINGLE}
                        selectionLabelIndex={2}
                        selectionKeyIndex={1}
                        dataUrl={`rest/signals-table-by-cid/${signalSet.cid}`}
                        disabled={!!(isEdit || isSignalsetTimeseries)}
                    />

                    <DateTimePicker
                        id={'offset'}
                        label={t("Offset")}
                        help={t('Where aggregation starts - can be empty for all data aggregation')}
                        showTime={true}
                        formatDate={(date, time) => {
                            const dateTime = moment(date);
                            dateTime.set(time);
                            return dateTime.format('YYYY-MM-DD HH:mm:ss');
                        }}
                        parseDate={str => this.parseDateTime(str)}
                        disabled={isEdit}
                    />

                    <InputField id="interval"
                                label={t('Interval')}
                                help={t('Bucket interval - add s(seconds), m(minute), h(hour), d(day) right after numeric value to select the unit.')}
                                placeholder={t(`type interval or select from the hints`)}
                                withHints={['30m', '1h', '12h', '1d', '30d']}
                                disabled={isEdit}/>


                    <ButtonRow>
                        {isEdit &&
                        <Button type="submit" className="btn-primary" label={t('Back')}
                                onClickAsync={() => this.navigateBack()}/>
                        }
                        {!isEdit &&
                        <>
                            <Button type="submit" className="btn-primary" icon="check" label={t('Save')}/>
                            <Button type="submit" className="btn-primary" icon="check" label={t('Save and leave')}
                                    onClickAsync={async () => await this.submitHandler(true)}/>
                        </>
                        }
                        {canDelete && <LinkButton className="btn-danger" icon="remove" label={t('Delete')}
                                                  to={`/settings/signal-sets/${signalSet.id}/aggregations/${aggJob.id}/delete`}/>}
                    </ButtonRow>
                </Form>
            </Panel>
        );
    }
}

