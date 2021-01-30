'use strict';

import React, {Component} from "react";
import moment
    from "moment";
import axios
    from "../lib/axios";
import {
    withAsyncErrorHandler,
    withErrorHandling
} from "../lib/error-handling";
import {intervalAccessMixin} from "../ivis/TimeContext";
import PropTypes
    from "prop-types";
import {getUrl} from "../lib/urls";
import {withComponentMixins} from "../lib/decorator-helpers";
import interoperableErrors
    from "../../../shared/interoperable-errors";

import {SUBSTITUTE_TS_SIGNAL} from "../../../shared/signal-sets";

// How many aggregationIntervals before and after an absolute interval is search for prev/next values. This is used only in aggregations to avoid unnecessary aggregations.
const prevNextSize = 100;
const docsLimitDefault = 1000;

export function forAggs(signals, fn) {
    const result = {};
    const aggs = Object.keys(signals[0]);
    for (const agg of aggs) {
        result[agg] = fn(...signals.map(d => d[agg]));
    }

    return result;
}

function getTsSignalCid(signalSet) {
    return signalSet.tsSigCid || SUBSTITUTE_TS_SIGNAL;
}

export const TimeSeriesPointType = {
    LTE: 'lte',
    LT: 'lt',
    GT: 'gt',
    GTE: 'gte'
};

class DataAccess {
    constructor() {
        this.resetFetchQueue();
        this.cache = {};

        this.queryTypes = {
            timeSeriesPoint: {
                getQueries: ::this.getTimeSeriesPointQueries,
                processResults: ::this.processTimeSeriesPointResults
            },
            timeSeries: {
                getQueries: ::this.getTimeSeriesQueries,
                processResults: ::this.processTimeSeriesResults
            },
            timeSeriesSummary: {
                getQueries: ::this.getTimeSeriesSummaryQueries,
                processResults: ::this.processTimeSeriesSummaryResults
            },
            docs: {
                getQueries: ::this.getDocsQueries,
                processResults: ::this.processDocsResults
            },
            histogram: {
                getQueries: ::this.getHistogramQueries,
                processResults: ::this.processHistogramResults
            },
            aggs: {
                getQueries: ::this.getAggsQueries,
                processResults: ::this.processAggsResults
            },
            summary: {
                getQueries: ::this.getSummaryQueries,
                processResults: ::this.processSummaryResults
            }
        };
    }

    async query(queries) {
        const reqData = [];
        const segments = [];
        let reqDataIdx = 0;

        for (const hlQuery of queries) {
            const qry = this.queryTypes[hlQuery.type].getQueries(...hlQuery.args);
            segments.push({
                start: reqDataIdx,
                len: qry.length
            });

            reqData.push(...qry);
            reqDataIdx += qry.length;
        }


        const fetchTaskData = this.fetchTaskData;
        const startIdx = fetchTaskData.reqData.length;

        fetchTaskData.reqData.push(...reqData);
        this.scheduleFetchTask();

        const resData = await fetchTaskData.promise;

        const responseData = resData.slice(startIdx, startIdx + reqData.length);


        const results = [];
        for (let idx = 0; idx < queries.length; idx++) {
            const hlQuery = queries[idx];
            const segment = segments[idx];

            const res = this.queryTypes[hlQuery.type].processResults(responseData.slice(segment.start, segment.start + segment.len), ...hlQuery.args);

            results.push(res);
        }

        return results;
    }


    /*
      sigSets = {
        [sigSetCid]: {
          tsSigCid: 'ts',
          signals: [sigCid],
          mustExist: [sigCid]
        }
      }
    */
    getTimeSeriesPointQueries(sigSets, ts, timeSeriesPointType) {
        const reqData = [];

        for (const sigSetCid in sigSets) {
            const sigSet = sigSets[sigSetCid];
            const tsSig = getTsSignalCid(sigSet);

            const qry = {
                sigSetCid,
                filter: {
                    type: 'and',
                    children: [
                        {
                            type: 'range',
                            sigCid: tsSig,
                            [timeSeriesPointType]: ts.toISOString()
                        }
                    ]
                }
            };

            if (sigSet.mustExist) {
                for (const sigCid of sigSet.mustExist) {
                    qry.filter.children.push({
                        type: 'mustExist',
                        sigCid
                    });
                }
            }

            if (sigSet.horizon) {
                const horizon = moment(ts);
                let op;

                if (timeSeriesPointType == TimeSeriesPointType.GT || timeSeriesPointType == TimeSeriesPointType.GTE) {
                    horizon.add(sigSet.horizon);
                    op = TimeSeriesPointType.LTE;
                } else if (timeSeriesPointType == TimeSeriesPointType.LT || timeSeriesPointType == TimeSeriesPointType.LTE) {
                    horizon.subtract(sigSet.horizon);
                    op = TimeSeriesPointType.GTE;
                } else {
                    throw new Error('Unsupported time series point type: ' + timeSeriesPointType);
                }

                tsRange[op] = horizon.toISOString();
            }


            const signals = [tsSig, ...sigSet.signals];

            qry.docs = {
                signals,
                sort: [
                    {
                        sigCid: tsSig,
                        order: (timeSeriesPointType === TimeSeriesPointType.LT || timeSeriesPointType === TimeSeriesPointType.LTE) ? 'desc' : 'asc'
                    },
                ],
                limit: 1
            };

            reqData.push(qry);
        }

        return reqData;
    }

    processTimeSeriesPointResults(responseData, sigSets) {
        const result = {};

        let idx = 0;
        for (const sigSetCid in sigSets) {
            const sigSetRes = responseData[idx];
            const sigSet = sigSets[sigSetCid];
            // When using time series, and tsSigCId is not specified, we get ts cid by server
            const tsSig = sigSet.tsSigCid || sigSetRes.tsSigCid;

            if (sigSetRes.docs.length > 0) {
                const doc = sigSetRes.docs[0];

                const data = {};
                for (const sigCid of sigSet.signals) {
                    data[sigCid] = doc[sigCid];
                }

                result[sigSetCid] = {
                    ts: moment(doc[tsSig]),
                    data: data
                }
            }

            idx += 1;
        }

        return result;
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
    getTimeSeriesQueries(sigSets, intervalAbsolute, docsLimit = docsLimitDefault) {
        const reqData = [];
        const fetchDocs = intervalAbsolute.aggregationInterval.valueOf() === 0;

        for (const sigSetCid in sigSets) {
            const sigSet = sigSets[sigSetCid];
            const tsSig = getTsSignalCid(sigSet);

            const queryBase = {
                sigSetCid,
                substitutionOpts: sigSet.substitutionOpts
            };

            const prevQry = {
                ...queryBase,
                filter: {
                    type: 'range',
                    sigCid: tsSig,
                    lt: intervalAbsolute.from.toISOString()
                }
            };

            const mainQry = {
                ...queryBase,
                filter: {
                    type: 'range',
                    sigCid: tsSig,
                    gte: intervalAbsolute.from.toISOString(),
                    lt: intervalAbsolute.to.toISOString()
                }
            };

            const nextQry = {
                ...queryBase,
                filter: {
                    type: 'range',
                    sigCid: tsSig,
                    gte: intervalAbsolute.to.toISOString()
                }
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
                    sort: [
                        {
                            sigCid: tsSig,
                            order: 'asc'
                        },
                    ],
                    limit: docsLimit
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

                prevQry.filter.gte = moment(intervalAbsolute.from).subtract(intervalAbsolute.aggregationInterval * prevNextSize).toISOString();
                nextQry.filter.lt = moment(intervalAbsolute.to).add(intervalAbsolute.aggregationInterval * prevNextSize).toISOString();

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
                const offsetFromDuration = moment.duration(intervalAbsolute.from.valueOf() % aggregationIntervalMs);
                const offsetToDuration = moment.duration(intervalAbsolute.to.valueOf() % aggregationIntervalMs);

                prevQry.aggs = [
                    {
                        sigCid: tsSig,
                        step: intervalAbsolute.aggregationInterval.toString(),
                        offset: offsetFromDuration.toString(),
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
                        offset: offsetFromDuration.toString(),
                        minDocCount: 1,
                        signals: sigs
                    }
                ];

                nextQry.aggs = [
                    {
                        sigCid: tsSig,
                        step: intervalAbsolute.aggregationInterval.toString(),
                        offset: offsetToDuration.toString(),
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

        return reqData;
    }

    processTimeSeriesResults(responseData, sigSets, intervalAbsolute, docsLimit = docsLimitDefault) {
        const result = {};
        const fetchDocs = intervalAbsolute.aggregationInterval && intervalAbsolute.aggregationInterval.valueOf() === 0;

        let idx = 0;
        for (const sigSetCid in sigSets) {
            const sigSetResPrev = responseData[idx];
            const sigSetResMain = responseData[idx + 1];
            const sigSetResNext = responseData[idx + 2];

            const sigSet = sigSets[sigSetCid];
            const tsSig = sigSet.tsSigCid || sigSetResMain.tsSigCid;

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
                main: [],
                isAggregated: !fetchDocs
            };

            if (fetchDocs) {
                if (sigSetResPrev.docs.length > 0) {
                    const doc = sigSetResPrev.docs[0];
                    sigSetRes.prev = {
                        ts: moment(doc[tsSig]),
                        data: processDoc(doc)
                    }
                }

                if (sigSetResMain.total <= docsLimit) {
                    for (const doc of sigSetResMain.docs) {
                        sigSetRes.main.push({
                            ts: moment(doc[tsSig]),
                            data: processDoc(doc)
                        });
                    }
                } else {
                    throw new interoperableErrors.TooManyPointsError();
                }

                if (sigSetResNext.docs.length > 0) {
                    const doc = sigSetResNext.docs[0];
                    sigSetRes.next = {
                        ts: moment(doc[tsSig]),
                        data: processDoc(doc)
                    }
                }

            } else {
                if (sigSetResPrev.aggs[0].buckets.length > 0) {
                    const agg = sigSetResPrev.aggs[0].buckets[0];
                    sigSetRes.prev = {
                        ts: moment(agg.key),
                        data: agg.values
                    }
                }

                for (const agg of sigSetResMain.aggs[0].buckets) {
                    sigSetRes.main.push({
                        ts: moment(agg.key),
                        data: agg.values
                    });
                }

                if (sigSetResNext.aggs[0].buckets.length > 0) {
                    const agg = sigSetResNext.aggs[0].buckets[0];
                    sigSetRes.next = {
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
    getTimeSeriesSummaryQueries(sigSets, intervalAbsolute) {
        const reqData = [];

        for (const sigSetCid in sigSets) {
            const sigSet = sigSets[sigSetCid];
            const tsSig = getTsSignalCid(sigSet);

            const qry = {
                sigSetCid,
                filter: {
                    type: 'range',
                    sigCid: tsSig,
                    gte: intervalAbsolute.from.toISOString(),
                    lt: intervalAbsolute.to.toISOString()
                }
            };

            qry.summary = {
                signals: sigSet.signals
            };

            reqData.push(qry);
        }

        return reqData;
    }

    processTimeSeriesSummaryResults(responseData, sigSets) {
        const result = {};
        let idx = 0;
        for (const sigSetCid in sigSets) {
            const sigSetRes = responseData[idx];
            result[sigSetCid] = sigSetRes.summary;
            idx += 1;
        }

        return result;
    }


    /*
      signals = [ sigCid1, sigCid2 ],
      metrics: { [sigCid]: ['min', 'max', 'avg', 'sum'] }    // additional metrics for each bucket, same format as signals in summary query
    */
    getHistogramQueries(sigSetCid, signals, maxBucketCounts, minSteps, filter, metrics) {
        if (Number.isInteger(maxBucketCounts) || maxBucketCounts === undefined)
            maxBucketCounts = signals.map(x => maxBucketCounts); // copy numeric value for each signal
        else if (signals.length !== maxBucketCounts.length)
            throw new Error("maxBucketCounts should be a single integer or an array with same length as signals");

        if (Number.isFinite(minSteps) || minSteps === undefined)
            minSteps = signals.map(x => minSteps); // copy numeric value for each signal
        else if (signals.length !== minSteps.length)
            throw new Error("minSteps should be a single number or an array with same length as signals");

        let bucketGroups = {};
        signals.map((sigCid, index) => {
            bucketGroups[sigCid + ":" + index] = {
                maxBucketCount: maxBucketCounts[index],
                minStep: minSteps[index]
            };
        });

        const qry = {
            sigSetCid,
            filter,
            bucketGroups: bucketGroups,
            aggs: []
        };

        let aggs = [qry];
        for (const [index, sigCid] of signals.entries()) {
            aggs = aggs[0].aggs;
            aggs.push(
                {
                    sigCid,
                    bucketGroup: sigCid + ":" + index,
                    minDocCount: 0,
                    aggs: []
                }
            );
        }

        if (metrics) {
            aggs[0].signals = metrics;
        }

        return [qry];
    }

    processHistogramResults(responseData, sigSetCid, signals) {
        const processBucketsRecursive = function (bucket) {
            let agg;
            if (bucket.aggs && bucket.aggs.length > 0) {
                agg = bucket.aggs[0];
                agg.buckets = agg.buckets.map(processBucketsRecursive);
            }
            delete bucket.aggs;
            return {...bucket, ...agg};
        };

        if (signals.length > 0) {
            return processBucketsRecursive(responseData[0]);
        } else {
            return {
                buckets: []
            };
        }
    }


    /*
        signals = [ sigCid1, sigCid2 ]
    */
    getDocsQueries(sigSetCid, signals, filter, sort, limit) {
        const qry = {
            sigSetCid,
            filter,
            docs: {
                signals,
                sort,
                limit
            }
        };

        return [qry];
    }

    processDocsResults(responseData, sigSetCid, signals) {
        return responseData[0].docs;
    }


    /*
        aggs = [ { sigCid, agg_type, <parameters of the aggregation> } ]
    */
    getAggsQueries(sigSetCid, filter, aggs) {
        const qry = {
            sigSetCid,
            filter,
            aggs
        };

        return [qry];
    }

    processAggsResults(responseData) {
        return responseData[0].aggs;
    }


    /*
        summary: {
            signals: {sigCid: ['min', 'max', 'avg']}
        }
     */
    getSummaryQueries(sigSetCid, filter, summary) {
        const qry = {
            sigSetCid,
            filter,
            summary
        };

        return [qry];
    }

    processSummaryResults(responseData) {
        return responseData[0].summary;
    }


    /* Private methods */
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
}

export const dataAccess = new DataAccess();

export class DataAccessSession {
    constructor() {
        this.requestNos = {};
    }

    async _getLatestMultiple(type, queries) {
        this.requestNos[type] = (this.requestNos[type] || 0) + 1;

        const requestNo = this.requestNos[type];

        const results = await dataAccess.query(queries);

        if (requestNo == this.requestNos[type]) {
            return results;
        } else {
            return null;
        }
    }

    async _getLatestOne(type, ...args) {
        const results = await this._getLatestMultiple(type, [{type, args}]);
        if (results) {
            return results[0];
        } else {
            return null;
        }
    }

    async getLatestTimeSeriesPoint(sigSets, ts, timeseriesPointType = TimeSeriesPointType.LTE) {
        return await this._getLatestOne('timeSeriesPoint', sigSets, ts, timeseriesPointType);
    }

    async getLatestTimeSeries(sigSets, intervalAbsolute) {
        return await this._getLatestOne('timeSeries', sigSets, intervalAbsolute);
    }

    async getLatestTimeSeriesSummary(sigSets, intervalAbsolute) {
        return await this._getLatestOne('timeSeriesSummary', sigSets, intervalAbsolute);
    }

    async getLatestHistogram(sigSetCid, signals, maxBucketCount, minStep, filter, metrics) {
        return await this._getLatestOne('histogram', sigSetCid, signals, maxBucketCount, minStep, filter, metrics);
    }

    async getLatestDocs(sigSetCid, signals, filter, sort, limit) {
        return await this._getLatestOne('docs', sigSetCid, signals, filter, sort, limit);
    }

    async getLatestSummary(sigSetCid, filter, summary) {
        return await this._getLatestOne('summary', sigSetCid, filter, summary);
    }

    async getLatestAggs(sigSetCid, filter, aggs) {
        return await this._getLatestOne('aggs', sigSetCid, filter, aggs);
    }

    async getLatestMixed(queries) {
        return await this._getLatestMultiple('mixed', queries);
    }
}


@withComponentMixins([
    withErrorHandling,
    intervalAccessMixin()
])
class TimeSeriesDataProvider extends Component {
    constructor(props) {
        super(props);

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetsData: null
        }
    }

    static propTypes = {
        fetchDataFun: PropTypes.func.isRequired,
        renderFun: PropTypes.func.isRequired,
        loadingRenderFun: PropTypes.func
    }

    componentDidUpdate(prevProps) {
        const prevAbs = this.getIntervalAbsolute(prevProps);
        if (prevAbs !== this.getIntervalAbsolute()) {
            this.fetchData();
        }
    }

    componentDidMount() {
        this.fetchData();
    }

    @withAsyncErrorHandler
    async fetchData() {
        try {
            const signalSetsData = await this.props.fetchDataFun(this.dataAccessSession, this.getIntervalAbsolute());

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
            if (this.props.loadingRenderFun) {
                return this.props.loadingRenderFun();
            } else {
                return null;
            }
        }
    }
}


export class TimeSeriesProvider extends Component {
    static propTypes = {
        intervalFun: PropTypes.func,
        signalSets: PropTypes.object.isRequired,
        renderFun: PropTypes.func.isRequired,
        loadingRenderFun: PropTypes.func
    }

    static defaultProps = {
        intervalFun: intervalAbsolute => intervalAbsolute
    }

    render() {
        return (
            <TimeSeriesDataProvider
                fetchDataFun={async (dataAccessSession, intervalAbsolute) => await dataAccessSession.getLatestTimeSeries(this.props.signalSets, this.props.intervalFun(intervalAbsolute))}
                renderFun={this.props.renderFun}
                loadingRenderFun={this.props.loadingRenderFun}
            />
        );
    }
}

export class TimeSeriesSummaryProvider extends Component {
    static propTypes = {
        intervalFun: PropTypes.func,
        signalSets: PropTypes.object.isRequired,
        renderFun: PropTypes.func.isRequired,
        loadingRenderFun: PropTypes.func
    }

    static defaultProps = {
        intervalFun: intervalAbsolute => intervalAbsolute
    }

    render() {
        return (
            <TimeSeriesDataProvider
                fetchDataFun={async (dataAccessSession, intervalAbsolute) => await dataAccessSession.getLatestTimeSeriesSummary(this.props.signalSets, this.props.intervalFun(intervalAbsolute))}
                renderFun={this.props.renderFun}
                loadingRenderFun={this.props.loadingRenderFun}
            />
        );
    }
}

export const TimeSeriesPointPredefs = {
    CURRENT: {
        getTs: intv => moment(),
        pointType: TimeSeriesPointType.LTE
    }
};

export class TimeSeriesPointProvider extends Component {
    static propTypes = {
        tsSpec: PropTypes.object,
        signalSets: PropTypes.object.isRequired,
        renderFun: PropTypes.func.isRequired,
        loadingRenderFun: PropTypes.func
    }

    static defaultProps = {
        tsSpec: TimeSeriesPointPredefs.CURRENT
    }

    render() {
        return (
            <TimeSeriesDataProvider
                fetchDataFun={async (dataAccessSession, intervalAbsolute) => await dataAccessSession.getLatestTimeSeriesPoint(this.props.signalSets, this.props.tsSpec.getTs(intervalAbsolute), this.props.tsSpec.pointType)}
                renderFun={this.props.renderFun}
                loadingRenderFun={this.props.loadingRenderFun}
            />
        );
    }
}

export class TimeSeriesLimitedPointsProvider extends Component {
    static propTypes = {
        signalSets: PropTypes.object.isRequired,
        limit: PropTypes.number.isRequired,
        renderFun: PropTypes.func.isRequired,
        loadingRenderFun: PropTypes.func
    }

    async fetchDataFun(dataAccessSession, intervalAbsolute) {
        const queries = [];
        const sigSets = Object.keys(this.props.signalSets);


        for (const sigSetCid of sigSets) {
            const sigSet = this.props.signalSets[sigSetCid];
            const tsSig = getTsSignalCid(sigSet);

            const filter = {
                type: 'and',
                children: [
                    {
                        type: 'range',
                        sigCid: tsSig,
                        [TimeSeriesPointType.LTE]: moment().toISOString()
                    }
                ]
            }

            const signals = [tsSig, ...sigSet.signals];

            const sort = [
                {
                    sigCid: tsSig,
                    order: 'desc'
                },
            ];

            queries.push({type: 'docs', args: [sigSetCid, signals, filter, sort, this.props.limit]});
        }

        const results = await dataAccessSession.getLatestMixed(queries);

        const data = {};

        if (results) {
            results.forEach((result, i) => {
                data[sigSets[i]] = result;
            })
        }

        return data;
    }

    render() {

        return (
            <TimeSeriesDataProvider
                fetchDataFun={::this.fetchDataFun}
                renderFun={this.props.renderFun}
                loadingRenderFun={this.props.loadingRenderFun}
            />
        );
    }
}
