import React, {Component} from "react";
import PropTypes from "prop-types";
import {PanelConfigAccess} from './PanelConfig';
import {Button} from "../lib/bootstrap-components";
import {Table, TableSelectMode} from "../lib/table";
import formStyles from "../lib/styles.scss";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {getSignalTypes} from "../settings/signal-sets/signals/signal-types";
import moment from "moment";
import memoize from "memoize-one";

const Type = {
    SIGNAL_SET: 'signalSet',
    SIGNAL: 'signal'
}

export class StaticSignalSelector extends Component {

    static propTypes = {
        sigSetCid: PropTypes.string,
        sigCid: PropTypes.string,
        onChange: PropTypes.func,
        className: PropTypes.string,
        data: PropTypes.array,
        columns: PropTypes.array,
        labelColumn: PropTypes.string
    }

    render() {
        return (
            <StaticSelector
                type={Type.SIGNAL}
                sigSetCid={this.props.sigSetCid}
                sigCid={this.props.sigCid}
                data={this.props.data}
                onChange={this.props.onChange}
                className={this.props.className}
                columns={this.props.columns}
                labelColumn={this.props.labelColumn}
            />
        )
    }
}

@withComponentMixins([
    withTranslation
])
class StaticSelector extends Component {
    constructor(props) {
        super(props);

        this.state = {
            selectedLabel: '',
            open: false
        };

        this.signalTypes = getSignalTypes(props.t);
    }

    static propTypes = {
        type: PropTypes.string,
        sigSetCid: PropTypes.string,
        sigCid: PropTypes.string,
        onChange: PropTypes.func,
        className: PropTypes.string,
        data: PropTypes.array,
        columns: PropTypes.array,
        labelColumn: PropTypes.string
    }

    static defaultProps = {
        columns: ['id', 'name', 'description', 'type', 'created', 'namespace'],
        labelColumn: 'id'
    }

    async onSelectionChangedAsync(sel, data) {
        this.setState({
            open: false
        });

        this.props.onChange(sel);
    }

    async onSelectionDataAsync(sel, data) {
        let label;

        if (!data) {
            label = '';
        } else {
            label = data[2];
        }

        this.setState({
            selectedLabel: label
        });
    }

    async toggleOpen() {
        this.setState({
            open: !this.state.open
        });
    }

    tableData = memoize(
        (data) => {
            let dataColumns = ['id', 'id', 'name', 'description', 'type', 'created', 'namespace'];

            const tableData = [];

            for (const entry of data) {
                const row = [];
                for (const colId of dataColumns) {
                    row.push(entry[colId]);
                }

                tableData.push(row);
            }

            return tableData;
        }
    );

    getAvailableColumns(type) {
        const t = this.props.t;
        if (type === Type.SIGNAL_SET) {
            return {
                id: {data: 1, title: t('Id')},
                name: {data: 2, title: t('Name')},
                description: {data: 3, title: t('Description')},
                type: {data: 4, title: t('Type')},
                state: {data: 5, title: t('State')},
                created: {data: 6, title: t('Created'), render: data => moment(data).fromNow()},
                settings: {data: 7, title: t('Settings')},
                namespace: {data: 8, title: t('Namespace')}
            };
        } else {
            return {
                id: {data: 1, title: t('Id')},
                name: {data: 2, title: t('Name')},
                description: {data: 3, title: t('Description')},
                type: {data: 4, title: t('Type'), render: data => this.signalTypes[data]},
                created: {data: 5, title: t('Created'), render: data => moment(data).fromNow()},
                namespace: {data: 6, title: t('Namespace')}
            };
        }
    }

    getDataUrl() {
        if (this.props.type === Type.SIGNAL_SET) {
            return `rest/signal-sets-table`;
        } else {
            return `rest/signals-table-by-cid/${this.props.sigSetCid}`;
        }
    }

    render() {
        const t = this.props.t;

        let availableColumns = this.getAvailableColumns(this.props.type);
        const columns = this.props.columns.map(colId => availableColumns[colId]);

        const dataProps = {};
        if (this.props.data) {
            dataProps.data = this.tableData(this.props.data);
        } else {
            dataProps.dataUrl = this.getDataUrl();
        }

        const selection = this.props.type === Type.SIGNAL_SET ? this.props.sigSetCid : this.props.sigCid;

        return (
            <div className={this.props.className}>
                <div>
                    <div className={'input-group ' + formStyles.tableSelectDropdown}>
                        <input type="text" className="form-control" value={this.state.selectedLabel} readOnly
                               onClick={::this.toggleOpen}/>
                        <div className="input-group-append">
                            <Button label={t('select')} className="btn-secondary" onClickAsync={::this.toggleOpen}/>
                        </div>
                    </div>
                    <div
                        className={formStyles.tableSelectTable + (this.state.open ? '' : ' ' + formStyles.tableSelectTableHidden)}>
                        <Table
                            columns={columns}
                            withHeader
                            selectMode={TableSelectMode.SINGLE}
                            selectionLabelIndex={availableColumns[this.props.labelColumn].data}
                            selectionKeyIndex={1}
                            selection={selection}
                            onSelectionDataAsync={::this.onSelectionDataAsync}
                            onSelectionChangedAsync={::this.onSelectionChangedAsync}
                            {...dataProps}
                        />
                    </div>
                </div>
            </div>
        );
    }
}

export class SignalSetSelector extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        configPath: PropTypes.array,
        statePath: PropTypes.array,
        className: PropTypes.string,
        data: PropTypes.array,
        columns: PropTypes.array
    }

    render() {
        return (
            <PanelConfigAccess configPath={this.props.configPath} statePath={this.props.statePath} render={
                (config, onChange) =>
                    <StaticSelector
                        type={Type.SIGNAL_SET}
                        sigSetCid={config}
                        data={this.props.data}
                        onChange={sigSetCid => onChange([], sigSetCid)}
                        className={this.props.className}
                        columns={this.props.columns}
                    />
            }/>
        );
    }
}

export class SignalSelector extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        sigSetCid: PropTypes.string,
        configPath: PropTypes.array,
        statePath: PropTypes.array,
        className: PropTypes.string,
        data: PropTypes.array,
        columns: PropTypes.array
    }

    render() {
        return (
            <PanelConfigAccess configPath={this.props.configPath} statePath={this.props.statePath} render={
                (config, onChange) =>
                    <StaticSelector
                        type={Type.SIGNAL}
                        sigSetCid={this.props.sigSetCid}
                        sigCid={config}
                        data={this.props.data}
                        onChange={sigCid => onChange([], sigCid)}
                        className={this.props.className}
                        columns={this.props.columns}
                    />
            }/>
        );
    }
}
