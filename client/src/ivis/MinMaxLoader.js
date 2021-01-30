'use strict';

import React, {Component} from "react";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {TimeIntervalDifference} from "./common";

/**
 * This component fetches the minimum and maximum for given signal(s) and calls props.processData with the values.
 * The values are given in form: { signalId: { min, max } }.
 * Time interval filtering (using TimeContext) is also supported.
 * It has no UI.
 */
@withComponentMixins([
    withTranslation,
    withErrorHandling,
    intervalAccessMixin()
], ["reloadData"])
export class MinMaxLoader extends Component {
    constructor(props){
        super(props);
        this.dataAccessSession = new DataAccessSession();
    }

    static propTypes = {
        config: PropTypes.shape({
            sigSetCid: PropTypes.string.isRequired,
            /** cids of signals: one string or array of strings */
            sigCids: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.string)]).isRequired,
            tsSigCid: PropTypes.string
        }).isRequired,
        processData: PropTypes.func.isRequired
    };

    static defaultProps = { };

    componentDidMount() {
        this.reloadData();
    }

    componentDidUpdate(prevProps, prevState) {
        let propsDiff = this.props.config.sigSetCid !== prevProps.config.sigSetCid ||
            this.props.config.sigCid !== prevProps.config.sigCid ||
            this.props.config.tsSigCid !== prevProps.config.tsSigCid;

        const considerTs = !!this.props.config.tsSigCid;
        if (considerTs)
            propsDiff |= TimeIntervalDifference(this, prevProps);

        if (propsDiff)
            this.reloadData();
    }

    reloadData() {
        // noinspection JSIgnoredPromiseFromCall
        this.fetchData();
    }

    @withAsyncErrorHandler
    async fetchData() {
        const config = this.props.config;

        try {
            let filter = {
                type: 'and',
                children: []
            };

            if (config.tsSigCid) {
                const abs = this.getIntervalAbsolute();
                filter.children.push({
                    type: 'range',
                    sigCid: config.tsSigCid,
                    gte: abs.from.toISOString(),
                    lt: abs.to.toISOString()
                });
            }

            const summary = {
                signals: {}
            };
            const signals = Array.isArray(config.sigCids) ? config.sigCids : [config.sigCids];
            for (const signal of signals)
                summary.signals[signal] = ["min", "max"];
            const query = {
                type: "summary",
                args: [config.sigSetCid, filter, summary]
            };

            const results = await this.dataAccessSession.getLatestMixed([query]);

            if (results) { // Results is null if the results returned are not the latest ones
                const res = results[0];
                this.props.processData(res);
            }
        } catch (err) {
            throw err;
        }
    }

    render() {
        return null;
    }
}
