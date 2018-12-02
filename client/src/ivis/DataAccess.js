'use strict';

import React, {Component} from "react";
import moment from "moment";
import axios from "../lib/axios";
import {withErrorHandling, withAsyncErrorHandler} from "../lib/error-handling";
import {withIntervalAccess} from "../ivis/TimeContext";
import PropTypes from "prop-types";
import {getUrl} from "../lib/urls";
import {IntervalAbsolute} from "./TimeInterval";

export function forAggs(signals, fn) {
    const result = {};
    const aggs = Object.keys(signals[0]);
    for (const agg of aggs) {
        result[agg] = fn(...signals.map(d => d[agg]));
    }

    return result;
}

class TimeBasedDataAccess {
    constructor() {
        this.resetFetchQueue();
        this.cache = {};
    }

    resetFetchQueue() {
        const fetchTaskData = {};

        fetchTaskData.scheduled = false;
        fetchTaskData.reqData = [];
        fetchTaskData.promise = new Promise((resolve, reject) => {
            fetchTaskData.successful = resolve;
            fetchTaskData.failed = reject;
        });

        this.fetchTaskData = fetchTaskData;
    }

    scheduleFetchTask() {
        if (!this.fetchTaskData.scheduled) {
            this.fetchTaskData.scheduled = true;
            setTimeout(() => this.executeFetchTask(), 0);
        }
    }

    async executeFetchTask() {
        const fetchTaskData = this.fetchTaskData;
        this.resetFetchQueue();

        try {
            const response = await axios.post(getUrl('rest/signals-query'), fetchTaskData.reqData);

            const signalsData = response.data;
            fetchTaskData.successful(signalsData);
        } catch (err) {
            fetchTaskData.failed(err);
        }
    }

    /*
      sigSets = {
        [sigSetCid]: {
          tsSigCid: 'ts',
          signals: {
            [sigCid]: [aggs]
          }
        }
      }
    */
    async getSignalSets(sigSets, intervalAbsolute) {
        const reqData = [];

        const fetchDocs = intervalAbsolute.aggregationInterval && intervalAbsolute.aggregationInterval.valueOf() === 0;

        for (const sigSetCid in sigSets) {
            const sigSet = sigSets[sigSetCid];
            const tsSig = sigSet.tsSigCid || 'ts';

            const prevQry = {
                sigSetCid,
                ranges: [
                    {
                        sigCid: tsSig,
                        lt: intervalAbsolute.from.toISOString()
                    }
                ]
            };

            const mainQry = {
                sigSetCid,
                ranges: [
                    {
                        sigCid: tsSig,
                        gte: intervalAbsolute.from.toISOString(),
                        lt: intervalAbsolute.to.toISOString()
                    }
                ]
            };

            const nextQry = {
                sigSetCid,
                ranges: [
                    {
                        sigCid: tsSig,
                        gte: intervalAbsolute.to.toISOString()
                    }
                ]
            };


            if (fetchDocs) {
                const signals = [tsSig, ...Object.keys(sigSet.signals)];

                prevQry.docs = {
                    signals,
                    sort: [
                        {
                            sigCid: tsSig,
                            order: 'desc'
                        },
                    ],
                    limit: 1
                };

                mainQry.docs = {
                    signals,
                };

                nextQry.docs = {
                    signals,
                    sort: [
                        {
                            sigCid: tsSig,
                            order: 'asc'
                        },
                    ],
                    limit: 1
                };

            } else {
                const sigs = {};
                for (const sigCid in sigSet.signals) {
                    const sig = sigSet.signals[sigCid];

                    if (Array.isArray(sig)) {
                        sigs[sigCid] = sig;
                    } else {
                        if (sig.mutate) {
                            sigs[sigCid] = sig.aggs;
                        }
                    }
                }

                const aggregationIntervalMs = intervalAbsolute.aggregationInterval.asMilliseconds();
                const offsetDuration = moment.duration(intervalAbsolute.from.valueOf() % aggregationIntervalMs);

                prevQry.aggs = [
                    {
                        sigCid: tsSig,
                        step: intervalAbsolute.aggregationInterval.toString(),
                        offset: offsetDuration.toString(),
                        minDocCount: 1,
                        signals: sigs,
                        order: 'desc',
                        limit: 1
                    }
                ];

                mainQry.aggs = [
                    {
                        sigCid: tsSig,
                        step: intervalAbsolute.aggregationInterval.toString(),
                        offset: offsetDuration.toString(),
                        minDocCount: 1,
                        signals: sigs
                    }
                ];

                nextQry.aggs = [
                    {
                        sigCid: tsSig,
                        step: intervalAbsolute.aggregationInterval.toString(),
                        offset: offsetDuration.toString(),
                        minDocCount: 1,
                        signals: sigs,
                        order: 'asc',
                        limit: 1
                    }
                ];
            }

            reqData.push(prevQry);
            reqData.push(mainQry);
            reqData.push(nextQry);
        }

        const fetchTaskData = this.fetchTaskData;
        const startIdx = fetchTaskData.reqData.length;

        fetchTaskData.reqData.push(...reqData);
        
        this.scheduleFetchTask();

        const responseData = await fetchTaskData.promise;

        const result = {};
        let idx = startIdx;
        for (const sigSetCid in sigSets) {
            const sigSetResPrev = responseData[idx];
            const sigSetResMain = responseData[idx + 1];
            const sigSetResNext = responseData[idx + 2];

            const sigSet = sigSets[sigSetCid];

            const processDoc = doc => {
                const data = {};
                for (const sigCid in sigSet.signals) {
                    const sig = sigSet.signals[sigCid];
                    const sigData = {};

                    let sigAggs;
                    if (Array.isArray(sig)) {
                        sigAggs = sig;
                    } else {
                        if (sig.mutate) {
                            sigAggs = sig.aggs;
                        }
                    }

                    for (const sigAgg of sigAggs) {
                        sigData[sigAgg] = doc[sigCid];
                    }

                    data[sigCid] = sigData;
                }

                return data;
            };

            const sigSetRes = {
                main: []
            };

            if (fetchDocs) {
                if (sigSetResPrev.docs.length > 0) {
                    const doc = sigSetResPrev.docs[0];
                    sigSetRes.prev = {
                        ts: moment(doc[tsSig]),
                        data: processDoc(doc)
                    }
                }

                for (const doc of sigSetResMain.docs) {
                    sigSetRes.main.push({
                        ts: moment(doc[tsSig]),
                        data: processDoc(doc)
                    });
                }

                if (sigSetResNext.docs.length > 0) {
                    const doc = sigSetResNext.docs[0];
                    sigSetRes.next = {
                        ts: moment(doc[tsSig]),
                        data: processDoc(doc)
                    }
                }

            } else {
                if (sigSetResPrev.aggs[0].length > 0) {
                    const agg = sigSetResPrev.aggs[0][0];
                    sigSetRes.prev = {
                        ts: moment(agg.key),
                        data: agg.values
                    }
                }

                for (const agg of sigSetResMain.aggs[0]) {
                    sigSetRes.main.push({
                        ts: moment(agg.key),
                        data: agg.values
                    });
                }

                if (sigSetResNext.aggs[0].length > 0) {
                    const agg = sigSetResNext.aggs[0][0];
                    sigSetRes.prev = {
                        ts: moment(agg.key),
                        data: agg.values
                    }
                }
            }

            for (const sigCid in sigSet.signals) {
                const sig = sigSet.signals[sigCid];

                if (!Array.isArray(sig)) {
                    if (sig.generate) {
                        if (sigSetRes.prev) {
                            sigSetRes.prev.data[sigCid] = sig.generate(sigSetRes.prev.ts, sigSetRes.prev.data);
                        }

                        if (sigSetRes.next) {
                            sigSetRes.next.data[sigCid] = sig.generate(sigSetRes.next.ts, sigSetRes.next.data);
                        }

                        for (const mainRes of sigSetRes.main) {
                            mainRes.data[sigCid] = sig.generate(mainRes.ts, mainRes.data);
                        }

                    } else if (sig.mutate) {
                        if (sigSetRes.prev) {
                            sigSetRes.prev.data[sigCid] = sig.mutate(sigSetRes.prev.data[sigCid], sigSetRes.prev.ts, sigSetRes.prev.data);
                        }

                        if (sigSetRes.next) {
                            sigSetRes.next.data[sigCid] = sig.mutate(sigSetRes.next.data[sigCid], sigSetRes.next.ts, sigSetRes.next.data);
                        }

                        for (const mainRes of sigSetRes.main) {
                            mainRes.data[sigCid] = sig.mutate(mainRes.data[sigCid], mainRes.ts, mainRes.data);
                        }
                    }
                }
            }

            result[sigSetCid] = sigSetRes;
            idx += 3;
        }

        return result;
    }
}

export const dataAccess = new TimeBasedDataAccess();

export class DataAccessSession {
    constructor() {
        this.requestNo = 0;
    }

    async getLatestSignalSets(sigSets, intervalAbsolute) {
        this.requestNo += 1;
        const requestNo = this.requestNo;

        const result = await dataAccess.getSignalSets(sigSets, intervalAbsolute);

        if (requestNo == this.requestNo) {
            return result;
        } else {
            return null;
        }
    }
}

@withErrorHandling
@withIntervalAccess()
export class TimeBasedDataProvider extends Component {
    constructor(props) {
        super(props);

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetsData: null
        }
    }

    static propTypes = {
        intervalFun: PropTypes.func,
        signalSets: PropTypes.object.isRequired,
        renderFun: PropTypes.func.isRequired
    }

    static defaultProps = {
        intervalFun: intervalAbsolute => intervalAbsolute
    }

    componentWillReceiveProps(nextProps, nextContext) {
        const nextAbs = this.getIntervalAbsolute(nextProps, nextContext);
        if (nextAbs !== this.getIntervalAbsolute()) {
            this.fetchData(nextAbs);
        }
    }

    componentDidMount() {
        this.fetchData(this.getIntervalAbsolute());
    }

    @withAsyncErrorHandler
    async fetchData(abs) {
        try {
            const signalSetsData = await this.dataAccessSession.getLatestSignalSets(this.props.signalSets, this.props.intervalFun(this.getIntervalAbsolute));

            if (signalSetsData) {
                this.setState({
                    signalSetsData
                });
            }
        } catch (err) {
            throw err;
        }
    }

    render() {
        if (this.state.signalSetsData) {
            return this.props.renderFun(this.state.signalSetsData)
        } else {
            return null;
        }
    }
}

export const DataPointType = {
    LATEST: 0
};

/*
export class DataPointProvider extends Component {
    constructor(props) {
        super(props);

        this.types = {};

        this.types[DataPointType.LATEST] = {
            intervalFun: intv => new IntervalAbsolute(intv.to, intv.to, moment.duration(0, 's')),
            dataSelector: data => data.prev.data
        }
    }

    static propTypes = {
        type: PropTypes.number,
        signalSets: PropTypes.object.isRequired,
        renderFun: PropTypes.func.isRequired
    }

    static defaultProps = {
        type: DataPointType.LATEST
    }

    transformSignalSetsData(signalSetsData) {
        const ret = {};

        for (const cid in signalSetsData) {
            const sigSetData = signalSetsData[cid];
            ret[cid] = this.types[this.props.type].dataSelector(sigSetData)
        }

        return ret;
    }

    render() {
        return (
            <TimeBasedDataProvider
                intervalFun={this.types[this.props.type].intervalFun}
                signalSets={this.props.signalSets}
                renderFun={signalSetsData => this.props.renderFun(this.transformSignalSetsData(signalSetsData))}
            />
        );
    }

}
*/