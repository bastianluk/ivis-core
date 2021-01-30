'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import * as d3Scale from "d3-scale";
import {select, event as d3Event} from "d3-selection";
import * as d3Selection from "d3-selection";
import * as d3Array from "d3-array";
import * as d3Color from "d3-color";
import * as d3Shape from "d3-shape";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {PropType_d3Color_Required, PropType_NumberInRange} from "../lib/CustomPropTypes";
import {withPageHelpers} from "../lib/page-common";
import {Tooltip} from "./Tooltip";
import {AreZoomTransformsEqual, ConfigDifference, isInExtent, setZoomTransform, TimeIntervalDifference, transitionInterpolate, WheelDelta, ZoomEventSources} from "./common";
import {Icon} from "../lib/bootstrap-components";
import * as d3Format from "d3-format";
import * as d3Zoom from "d3-zoom";
import commonStyles from "./commons.scss";

function compareConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.signalSets.length !== conf2.signalSets.length)
        return ConfigDifference.DATA_WITH_CLEAR;

    for (let i = 0; i < conf1.signalSets.length; i++) {
        const signalSetConfigComparison = compareSignalSetConfigs(conf1.signalSets[i], conf2.signalSets[i]);
        if (signalSetConfigComparison > diffResult)
            diffResult = signalSetConfigComparison;
    }

    return diffResult;
}

function compareSignalSetConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.cid !== conf2.cid || conf1.sigCid !== conf2.sigCid || conf1.tsSigCid !== conf2.tsSigCid) {
        diffResult = ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.color !== conf2.color) {
        diffResult = ConfigDifference.RENDER;
    }

    return diffResult;
}

class TooltipContent extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        signalSetsData: PropTypes.array,
        selection: PropTypes.object,
        tooltipFormat: PropTypes.func.isRequired
    };

    render() {
        if (this.props.selection) {
            const data = this.props.signalSetsData[this.props.selection.violinIndex];
            const step = data.step;
            const bucket = this.props.selection.bucket;
            const keyF = d3Format.format("." + d3Format.precisionFixed(step) + "f");

            return (
                <div>
                    <div><b>{this.props.selection.label}</b></div>
                    {bucket && <>
                        <div>Range: <Icon icon="chevron-left"/>{keyF(bucket.key)} <Icon icon="ellipsis-h"/> {keyF(bucket.key + step)}<Icon icon="chevron-right"/></div>
                        <div>{this.props.tooltipFormat(bucket)}</div>
                    </>}
                </div>
            );
        } else {
            return null;
        }
    }
}

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withPageHelpers,
    intervalAccessMixin()
], ["getView", "setView"], ["processBucket", "processDataForAdditionalLines", "prepareData", "prepareDataForSignalSet"])
export class ViolinPlot extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetsData: null,
            statusMsg: t('Loading...'),
            width: 0,
            maxBucketCount: 0,
            zoomTransform: d3Zoom.zoomIdentity,
            zoomInProgress: false,
        };

        this.xWidthScales = [];
        this.zoom = null;
        this.lastZoomCausedByUser = false;

        this.resizeListener = () => {
            this.createChart(true);
        };
    }

    static propTypes = {
        config: PropTypes.shape({
            signalSets: PropTypes.arrayOf(PropTypes.shape({
                cid: PropTypes.string.isRequired,
                sigCid: PropTypes.string.isRequired,
                tsSigCid: PropTypes.string, // for use of TimeContext
                color: PropType_d3Color_Required(),
                label: PropTypes.string,
                metric_sigCid: PropTypes.string,
                metric_type: PropTypes.oneOf(["sum", "min", "max", "avg"]),
                filter: PropTypes.object,
            })).isRequired
        }).isRequired,

        height: PropTypes.number.isRequired,
        margin: PropTypes.object,

        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        minStep: PropTypes.number,
        minBarHeight: PropTypes.number,
        maxBucketCount: PropTypes.number,
        commonWidthScale: PropTypes.bool, // if set to true, all violins will be rendered using the same width scale (if the maximum bucket value in one violin is a half of the maximum bucket value of another violin, the first violin's width will be 2 time smaller); if set to false (default), each violin will have its own width scale (each violin's maximum width is the same)
        padding: PropType_NumberInRange(0, 1), // empty space around each violin
        yMinValue: PropTypes.number,
        yMaxValue: PropTypes.number,
        curve: PropTypes.func, // d3Shape curve to render the violin (d3Shape.curveCatmullRom is default, use curveVerticalStep from 'ivis' to get a histogram look)

        withCursor: PropTypes.bool,
        withZoom: PropTypes.bool,
        withTransition: PropTypes.bool,
        withTooltip: PropTypes.bool,
        tooltipFormat: PropTypes.func, // bucket => line in tooltip

        additionalLines: PropTypes.arrayOf(PropTypes.shape({
            value: PropTypes.oneOf(["min", "max", "avg", "median", "percentile"]),
            percents: PropTypes.oneOfType([PropType_NumberInRange(0, 100)]), // only valid when value == "percentile" // code comment: wrapping PropType_NumberInRange in oneOfType allows it to also be undefined (without it, it must be a number)
            props: PropTypes.object, // props of the SVG <line>, if not specified, 'additionalLinesProps' is used
        })).isRequired, // add horizontal lines to the violin plot marking certain values; note: these lines do not respect metric_sigCid and metric_type
        additionalLinesProps: PropTypes.object, // props of the SVG <line>

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.object,
        processBucket: PropTypes.func, // see ViolinPlot.processBucket for reference
        processDataForAdditionalLines: PropTypes.func, // see ViolinPlot.processDataForAdditionalLines for reference
        prepareData: PropTypes.func, // see ViolinPlot.prepareData for reference
        prepareDataForSignalSet: PropTypes.func, // see ViolinPlot.prepareDataForSignalSet for reference
        getData: PropTypes.func,
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        minBarHeight: 20,
        maxBucketCount: undefined,
        commonWidthScale: false,
        padding: 0.2,
        yMinValue: NaN,
        yMaxValue: NaN,

        withCursor: true,
        withZoom: true,
        withTransition: true,
        withTooltip: true,

        additionalLines: [],
        additionalLinesProps: { strokeWidth: 2, stroke: "black" },

        zoomLevelMin: 1,
        zoomLevelMax: 4,

        tooltipFormat: bucket => `Count: ${bucket.count}`,

        curve: d3Shape.curveCatmullRom,
    };

    componentDidMount() {
        window.addEventListener('resize', this.resizeListener);
        this.createChart(false);
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const t = this.props.t;

        let configDiff = compareConfigs(this.props.config, prevProps.config);

        // test if time interval changed
        const considerTs =  this.props.config.signalSets.some(setConf => !!setConf.tsSigCid);
        if (considerTs)
            configDiff = Math.max(configDiff, TimeIntervalDifference(this, prevProps));

        // test if limits changed
        if (!Object.is(prevProps.yMinValue, this.props.yMinValue) || !Object.is(prevProps.yMaxValue, this.props.yMaxValue))
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);

        if (prevState.maxBucketCount !== this.state.maxBucketCount) {
            configDiff = Math.max(configDiff, ConfigDifference.DATA);
        }

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR) {
            this.setZoom(d3Zoom.zoomIdentity); // reset zoom
            this.setState({
                statusMsg: t('Loading...')
            }, () => {
                // noinspection JSIgnoredPromiseFromCall
                this.fetchData();
            });
        }
        else if (configDiff === ConfigDifference.DATA) {
            // noinspection JSIgnoredPromiseFromCall
            this.fetchData();
        }
        else {
             const forceRefresh = this.prevContainerNode !== this.containerNode
                || prevState.signalSetsData !== this.state.signalSetsData
                || configDiff !== ConfigDifference.NONE
                || prevProps.height !== this.props.height;

             const updateZoom = !AreZoomTransformsEqual(prevState.zoomTransform, this.state.zoomTransform);

             this.createChart(forceRefresh, updateZoom);
             this.prevContainerNode = this.containerNode;
            if (updateZoom)
                this.callViewChangeCallback();
        }
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.resizeListener);
    }

    getQueryForSignalSet(signalSetConfig, maxBucketCount, minStep) {
        let filter = {
            type: 'and',
            children: []
        };
        if (signalSetConfig.tsSigCid) {
            const abs = this.getIntervalAbsolute();
            filter.children.push({
                type: 'range',
                sigCid: signalSetConfig.tsSigCid,
                gte: abs.from.toISOString(),
                lt: abs.to.toISOString()
            });
        }
        if (!isNaN(this.props.yMinValue))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.sigCid,
                gte: this.props.yMinValue
            });
        if (!isNaN(this.props.yMaxValue))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.sigCid,
                lte: this.props.yMaxValue
            });
        if (signalSetConfig.filter)
            filter.children.push(signalSetConfig.filter);
        if (this.props.filter)
            filter.children.push(this.props.filter);

        let metrics;
        if (this.props.config.metric_sigCid && this.props.config.metric_type) {
            metrics = {};
            metrics[this.props.config.metric_sigCid] = [this.props.config.metric_type];
        }

        return {
            type: "histogram",
            args: [signalSetConfig.cid, [signalSetConfig.sigCid], maxBucketCount, minStep, filter, metrics]
        };
    }

    getAdditionalLinesQueriesForSignalSet(signalSetConfig) {
        let filter = {
            type: 'and',
            children: []
        };
        if (signalSetConfig.tsSigCid) {
            const abs = this.getIntervalAbsolute();
            filter.children.push({
                type: 'range',
                sigCid: signalSetConfig.tsSigCid,
                gte: abs.from.toISOString(),
                lt: abs.to.toISOString()
            });
        }
        if (!isNaN(this.props.yMinValue))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.sigCid,
                gte: this.props.yMinValue
            });
        if (!isNaN(this.props.yMaxValue))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.sigCid,
                lte: this.props.yMaxValue
            });
        if (signalSetConfig.filter)
            filter.children.push(signalSetConfig.filter);
        if (this.props.filter)
            filter.children.push(this.props.filter);

        const queries = [];

        for (const l of this.props.additionalLines) {
            if (l.value === "min" || l.value === "max" || l.value === "avg") {
                const summary = {
                    signals: {}
                };
                summary.signals[signalSetConfig.sigCid] = [l.value];
                queries.push({
                    type: "summary",
                    args: [signalSetConfig.cid, filter, summary]
                });
            }
            else { // percentiles
                if (l.value === "median")
                    l.percents = 50;
                queries.push({
                    type: "aggs",
                    args: [signalSetConfig.cid, filter, [{
                        sigCid: signalSetConfig.sigCid,
                        agg_type: "percentiles",
                        percents: l.percents,
                        keyed: false,
                    }]]
                });
            }
        }

        return queries;
    }

    /** Fetches new data for the chart, processes the results using prepareData method and updates the state accordingly, so the chart is redrawn */
    @withAsyncErrorHandler
    async fetchData() {
        if (typeof this.props.getData === "function") {
            this.setState(this.getData());
            return;
        }

        let maxBucketCount = this.props.maxBucketCount || this.state.maxBucketCount;
        if (!AreZoomTransformsEqual(this.state.zoomTransform, d3Zoom.zoomIdentity)) // allow more buckets if zoomed in
            maxBucketCount = Math.ceil(maxBucketCount * this.state.zoomTransform.k);
        let minStep = this.props.minStep;
        if (maxBucketCount > 0) {
            try {
                const queries = [];
                for (const signalSetConfig of this.props.config.signalSets)
                    queries.push(this.getQueryForSignalSet(signalSetConfig, maxBucketCount, minStep));
                if (this.props.additionalLines)
                    for (const signalSetConfig of this.props.config.signalSets)
                        queries.push(...this.getAdditionalLinesQueriesForSignalSet(signalSetConfig));

                const results = await this.dataAccessSession.getLatestMixed(queries);

                if (results) { // Results is null if the results returned are not the latest ones
                    const prepareData = this.props.prepareData || ViolinPlot.prepareData;
                    const processedResults = prepareData(this, results);
                    if (!processedResults.signalSetsData.some(d => d.buckets.length > 0)) {
                        this.setState({
                            signalSetsData: null,
                            statusMsg: this.props.t("No data.")
                        });
                        return;
                    }

                    // update extent of x axis
                    this.yExtent = [processedResults.min, processedResults.max];
                    if (!isNaN(this.props.yMinValue)) this.yExtent[0] = this.props.yMinValue;
                    if (!isNaN(this.props.yMaxValue)) this.yExtent[1] = this.props.yMaxValue;

                    this.setState(processedResults);
                }
            } catch (err) {
                this.setState({statusMsg: this.props.t("Error loading data.")});
                throw err;
            }
        }
    }

    /**
     * The value returned from this function is used to determine the height of the bar corresponding to the bucket.
     *
     * @param {ViolinPlot} self - this ViolinPlot object
     * @param {object} bucket - the record from server; contains 'count' field, and also 'values' field if metrics were specified
     */
    static processBucket(self, bucket) {
        const config = self.props.config;
        if (config.metric_sigCid && config.metric_type) {
            bucket.metric = bucket.values[config.metric_sigCid][config.metric_type];
            delete bucket.values;
            return bucket.metric;
        }
        else
            return bucket.count;
    }

    /**
     * Computes the y coordinates of the additional lines specified in props.additionalLines
     *
     * @param {ViolinPlot} self - this ViolinPlot object
     * @param data - data from the server (array of query results)
     * @param signalSetConfig - config of the corresponding signalSet
     */
    static processDataForAdditionalLines(self, data, signalSetConfig) {
        const ret = [];
        for (const [i, d] of data.entries()) {
            if (Array.isArray(d) && d.length === 1 && d[0].agg_type === "percentiles") {
                ret.push(d[0].values[0].value);
            }
            else if (typeof(d) === "object" && d.hasOwnProperty(signalSetConfig.sigCid)) {
                ret.push(d[signalSetConfig.sigCid][self.props.additionalLines[i].value]);
            }
            else
                self.setFlashMessage("error", `Error when processing data for additional lines.`);
        }
        return ret;
    }

    /**
     * Processes the data returned from the server and returns new signalSetData object.
     *
     * @param {ViolinPlot} self - this ViolinPlot object
     * @param {object} data - the data from server; contains at least 'buckets', 'step' and 'offset' fields
     * @param signalSetConfig - configuration of the corresponding signalSet
     * @param additionalLinesData - the data from server for values of props.additionalLines
     *
     * @returns {object} - signalSet data to be saved to state; must contain (if valid):
     *
     *   - 'buckets' - array of objects with 'key' (lowest value of the bucket) and 'prob' (frequency; height of the bucket)
     *   - 'step' - width of the bucket
     *   - 'min' and 'max' (along the y-axis)
     *   - 'maxValue' - value (count of elements) of the most frequent bucket
     */
    static prepareDataForSignalSet(self, data, signalSetConfig, additionalLinesData) {
        if (data.buckets.length === 0)
            return {
                buckets: [],
                maxValue: 0
            };
        if (isNaN(data.step)) { // not a numeric signal
            self.setFlashMessage("warning", `ViolinPlot is not available for non-numeric signal: '${signalSetConfig.cid}:${signalSetConfig.sigCid}'.`);
            return {
                buckets: [],
                maxValue: 0
            };
        }

        const min = data.buckets[0].key;
        const max = data.buckets[data.buckets.length - 1].key + data.step;

        const processBucket = self.props.processBucket || ViolinPlot.processBucket;
        for (const bucket of data.buckets)
            bucket.value = processBucket(self, bucket);

        let maxValue = 0;
        let totalValue = 0;
        for (const bucket of data.buckets) {
            if (bucket.value > maxValue)
                maxValue = bucket.value;
            totalValue += bucket.value;
        }

        for (const bucket of data.buckets) {
            bucket.prob = bucket.value / totalValue;
        }

        const processDataForAdditionalLines = self.props.processDataForAdditionalLines || ViolinPlot.processDataForAdditionalLines;
        const additionalValues = processDataForAdditionalLines(self, additionalLinesData, signalSetConfig);

        // add an empty bucket before and after to have spiky ends of violins
        const bucketBefore = {
            key: min - data.step,
            value: 0, count: 0, prob: 0,
        }
        const bucketAfter = {
            key: max,
            value: 0, count: 0, prob: 0,
        }
        return {
            buckets: [bucketBefore, ...data.buckets, bucketAfter],
            step: data.step,
            offset: data.offset,
            min: min - data.step, // add margin to the chart
            max: max + data.step,
            maxValue,
            additionalValues,
        };
    }

    /**
     * Processes the data returned from the server and returns new state.
     *
     * @param {ViolinPlot} self - this ViolinPlot object
     * @param {object} data - the data from server, an array of objects containing 'buckets', 'step' and 'offset' fields
     *
     * @returns {object} - state update (will be passed to this.setState); must contain:
     *
     *   - 'signalSetsData' - array of objects with 'buckets' and 'step' fields.
     *                        'buckets' must be an array in which each item contains 'key' (vertical position of the bucket) and 'prob' (frequency; width of the violin)
     *                        'step' is the width of the bucket (in units of data)
     *   - 'min' and 'max' (out of all signalSets)
     *   - 'maxValue' - value (count of elements) of the most frequent bucket (out of all signalSets)
     *   - 'statusMsg': "" (to reset the "Loading..." status message)
     */
    static prepareData(self, data) {
        const processedResults = [];
        const prepareDataForSignalSet = self.props.prepareDataForSignalSet || ViolinPlot.prepareDataForSignalSet;

        for (let i = 0; i < self.props.config.signalSets.length; i++) {
            const signalSetConfig = self.props.config.signalSets[i];
            const n = self.props.config.signalSets.length;
            const l = self.props.additionalLines.length;
            processedResults.push(prepareDataForSignalSet(self, data[i], signalSetConfig, data.slice(n + l * i, n + l * (i+1)))); // data[i] == histogram query, the rest are queries for additional lines
        }

        const min = d3Array.min(processedResults, d => d.min);
        const max = d3Array.max(processedResults, d => d.max);
        const maxValue = d3Array.max(processedResults, d => d.maxValue);

        return {
            signalSetsData: processedResults,
            min,
            max,
            maxValue,
            statusMsg: "",
        };
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated. */
    createChart(forceRefresh, updateZoom) {
        const signalSetsData = this.state.signalSetsData;

        const maxBucketCount = Math.ceil(this.props.height / this.props.minBarHeight);
        if (maxBucketCount !== this.state.maxBucketCount)
            this.setState({
                maxBucketCount
            });

        const width = this.containerNode.getClientRects()[0].width;
        const widthChanged = width !== this.state.width;
        if (widthChanged)
            this.setState({width});
        if (!forceRefresh && !widthChanged && !updateZoom) {
            return;
        }

        if (!signalSetsData) {
            return;
        }

        //<editor-fold desc="Scales">
        const ySize = this.props.height - this.props.margin.top - this.props.margin.bottom;
        const xSize = width - this.props.margin.left - this.props.margin.right;

        const xExtent = this.props.config.signalSets.map((b, i) => b.label || i);
        const xScale = d3Scale.scalePoint()
            .domain(xExtent)
            .range([0, xSize])
            .padding(0.5);
        this.xScale = xScale;
        const xAxis = d3Axis.axisBottom(xScale)
            .tickSizeOuter(0);
        this.xAxisSelection.call(xAxis);
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");

        let yScale = d3Scale.scaleLinear()
            .domain(this.yExtent)
            .range([ySize, 0]);
        yScale = this.state.zoomTransform.rescaleY(yScale);
        this.yScale = yScale;
        const yAxis = d3Axis.axisLeft(yScale);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        this.yAxisSelection.call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");
        //</editor-fold>

        this.drawChart(signalSetsData, xScale, yScale);

        this.createChartCursor(xSize, ySize, xScale, yScale, signalSetsData);

        if (forceRefresh || widthChanged) // no need to update this.zoom object when only updating current zoom (zoomTransform)
            this.createChartZoom(xSize, ySize);
    }

    drawChart(signalSetsData, xScale, yScale) {
        const violinWidth = (xScale.step() / 2) * (1 - this.props.padding); // width of one side of the violin
        this.xWidthScales = [];

        for (let i = 0; i < this.props.config.signalSets.length; i++) {
            const config = this.props.config.signalSets[i];
            const data = signalSetsData[i];
            const color = d3Color.color(config.color);
            const verticalPosition = key => yScale(key + data.step / 2); // 'key' is the lowest value in bucket -> this returns the center

            const xWidthScale = d3Scale.scaleLinear()
                .domain([0, this.props.commonWidthScale ? this.state.maxValue : data.maxValue])
                .range([0, violinWidth]);
            this.xWidthScales[i] = xWidthScale;

            this.drawViolin(data.buckets, this.violinSelections[i], xScale(config.label || i), xWidthScale, verticalPosition, color, this.props.curve);
            this.drawAdditionalLines(data.additionalValues, this.additionalLinesSelections[i], xScale(config.label || i) - violinWidth / 2, xScale(config.label || i) + violinWidth / 2,  yScale)
        }
    }

    /**
     * @param data             data in format as produces by ViolinPlot.prepareDataForSignalSet
     * @param path             d3 selection of <path> to which the data will get assigned and drawn
     * @param xPosition {number}
     * @param xWidthScale      d3Scale to convert probability of the bucket to the width of the violin
     * @param yScale           d3Scale to convert key of the bucket to the vertical position
     * @param color            fill color
     * @param curve            d3Shape curve used for rendering
     */
    drawViolin(data, path, xPosition, xWidthScale, yScale, color, curve) {
        const violin = d3Shape.area()
            .y(d => yScale(d.key))
            .x0(d => xPosition - xWidthScale(d.value))
            .x1(d => xPosition + xWidthScale(d.value))
            .curve(curve);

        path.datum(data)
            .attr('fill', color)
            .attr('stroke', 'none')
            .attr('stroke-linejoin', 'round')
            .attr('stroke-linecap', 'round')
            .attr('d', violin);
    }

    drawAdditionalLines(data, selection, xLeft, xRight, yScale) {
        const lines = selection
            .selectAll("line")
            .data(data);

        lines
            .attr('x1', xLeft)
            .attr('x2', xRight)
            .attr('y1', d => yScale(d))
            .attr('y2', d => yScale(d));
    }

    /** Handles mouse movement to display cursor line.
     *  Called from this.createChart(). */
    createChartCursor(xSize, ySize, xScale, yScale, signalSetsData) {
        const self = this;

        const mouseMove = function () {
            if (self.state.zoomInProgress)
                return;

            const containerPos = d3Selection.mouse(self.containerNode);
            const y = containerPos[1] - self.props.margin.top;
            const x = containerPos[0] - self.props.margin.left;

            self.cursorSelection
                .attr('y1', containerPos[1])
                .attr('y2', containerPos[1])
                .attr('x1', self.props.margin.left)
                .attr('x2', xSize + self.props.margin.left)
                .attr('visibility', self.props.withCursor ? 'visible' : "hidden");

            let newSelection = null;
            const halfStep = xScale.step() / 2;
            let violinIndex = 0;
            // we will only show tooltip for one violin
            // first find the violin under the mouse
            for (let i = 0; i < self.props.config.signalSets.length; i++) {
                const label = self.props.config.signalSets[i].label || i;
                const violinLeftBorder = xScale(label) - halfStep;
                if (violinLeftBorder < x)
                    violinIndex = i;
                else
                    break;
            }
            // now select the bucket
            const data = signalSetsData[violinIndex];
            const label =  self.props.config.signalSets[violinIndex].label || violinIndex;
            const key = yScale.invert(y);
            if (isInExtent(key, [data.min, data.max])) {
                for (const bucket of data.buckets) {
                    if (bucket.key <= key) {
                        newSelection = bucket;
                    } else {
                        break;
                    }
                }
            }

            if (self.props.withTooltip) {
                if (newSelection) {
                    const config = self.props.config.signalSets[violinIndex];
                    self.highlightDotSelection1
                        .attr("visibility", "visible")
                        .attr("cx", xScale(label) + self.xWidthScales[violinIndex](newSelection.value))
                        .attr("cy", yScale(newSelection.key + data.step / 2))
                        .attr("fill", d3Color.color(config.color).darker());
                    self.highlightDotSelection2
                        .attr("visibility", "visible")
                        .attr("cx", xScale(label) - self.xWidthScales[violinIndex](newSelection.value))
                        .attr("cy", yScale(newSelection.key + data.step / 2))
                        .attr("fill", d3Color.color(config.color).darker());
                }
                else {
                    self.highlightDotSelection1.attr("visibility", "hidden");
                    self.highlightDotSelection2.attr("visibility", "hidden");
                }
            }

            const mousePosition = {x: containerPos[0], y: containerPos[1]};
            const tooltip = {
                y: yScale.invert(y),
                violinIndex,
                bucket: newSelection,
                label,
            }

            self.setState({
                tooltip,
                mousePosition
            });
        };

        const mouseLeave = function () {
            self.deselectPoints();
        }

        this.cursorAreaSelection
            .on('mouseenter', mouseMove)
            .on('mousemove', mouseMove)
            .on('mouseleave', mouseLeave);
    }

    deselectPoints() {
        this.cursorSelection.attr('visibility', 'hidden');
        this.setState({
            tooltip: null,
            mousePosition: null
        });
        this.highlightDotSelection1.attr("visibility", "hidden");
        this.highlightDotSelection2.attr("visibility", "hidden");
    }

    /** Handles zoom of the chart by user using d3-zoom.
     *  Called from this.createChart(). */
    createChartZoom(xSize, ySize) {
        // noinspection DuplicatedCode
        const self = this;

        const handleZoom = function () {
            // noinspection JSUnresolvedVariable
            if (self.props.withTransition && d3Event.sourceEvent && d3Event.sourceEvent.type === "wheel") {
                self.lastZoomCausedByUser = true;
                transitionInterpolate(select(self), self.state.zoomTransform, d3Event.transform, setZoomTransform(self), () => {
                    self.deselectPoints();
                });
            } else {
                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                    self.lastZoomCausedByUser = true;
                // noinspection JSUnresolvedVariable
                setZoomTransform(self)(d3Event.transform);
            }
        };

        const handleZoomEnd = function () {
            self.deselectPoints();
            self.setState({
                zoomInProgress: false
            });
        };
        const handleZoomStart = function () {
            self.deselectPoints();
            self.setState({
                zoomInProgress: true
            });
        };

        const zoomExtent = [[0,0], [xSize, ySize]];
        const zoomExisted = this.zoom !== null;
        this.zoom = zoomExisted ? this.zoom : d3Zoom.zoom();
        this.zoom
            .scaleExtent([this.props.zoomLevelMin, this.props.zoomLevelMax])
            .translateExtent(zoomExtent)
            .extent(zoomExtent)
            .on("zoom", handleZoom)
            .on("end", handleZoomEnd)
            .on("start", handleZoomStart)
            .wheelDelta(WheelDelta(2))
            .filter(() => {
                if (d3Event.type === "wheel" && !d3Event.shiftKey)
                    return false;
                return !d3Event.ctrlKey && !d3Event.button;
            });
        this.svgContainerSelection.call(this.zoom);
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{yMin: number, yMax: number }} top, bottom boundary
     */
    getView() {
        const [yMin, yMax] = this.yScale.domain();
        return {yMin, yMax};
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels)
     * @param yMin          bottom boundary of the visible region (in units of data on x-axis)
     * @param yMax          top boundary of the visible region (in units of data on x-axis)
     * @param source        the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    setView(yMin, yMax, source, causedByUser = false) {
        if (source === this || this.state.signalSetsData === null)
            return;

        if (yMin === undefined) yMin = this.yScale.domain()[0];
        if (yMax === undefined) yMax = this.yScale.domain()[1];

        if (isNaN(yMin) || isNaN(yMax))
            throw new Error("Parameters must be numbers.");

        this.lastZoomCausedByUser = causedByUser;
        // noinspection JSUnresolvedVariable
        this.setZoomToLimits(yMin, yMax);
    }

    /** Sets zoom object (transform) to desired view boundaries. */
    setZoomToLimits(yMin, yMax) {
        const newYSize = yMax - yMin;
        const oldYSize = this.yScale.domain()[1] - this.yScale.domain()[0];

        const bottomInverted = this.state.zoomTransform.invertY(this.yScale(yMin));
        const transform = d3Zoom.zoomIdentity.scale(this.state.zoomTransform.k * oldYSize / newYSize).translate(0, -bottomInverted);

        this.setZoom(transform);
    }

    /** Helper method to update zoom transform in state and zoom object. */
    setZoom(transform) {
        if (this.zoom)
            this.svgContainerSelection.call(this.zoom.transform, transform);
        else {
            this.setState({zoomTransform: transform});
        }
    }

    callViewChangeCallback() {
        if (typeof(this.props.viewChangeCallback) !== "function")
            return;

        this.props.viewChangeCallback(this, this.getView(), this.lastZoomCausedByUser);
    }

    render() {
        if (!this.state.signalSetsData) {
            return (
                <svg ref={node => this.containerNode = node} height={this.props.height} width="100%"
                     className={this.props.className} style={this.props.style} >
                    <text textAnchor="middle" x="50%" y="50%" fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                        {this.state.statusMsg}
                    </text>
                </svg>
            );

        } else {

            this.violinSelections = [];
            const violinSelectionPaths = this.props.config.signalSets.map((signalSet, i) =>
                <path key={i}
                      ref={node => this.violinSelections[i] = select(node)}/>
            );

            this.additionalLinesSelections = [];
            const additionalLines = this.props.config.signalSets.map((signalSet, i) =>
                <g key={i}
                      ref={node => this.additionalLinesSelections[i] = select(node)}>
                    {this.props.additionalLines.map((l, j) =>
                        <line key={j}
                              {...(l.props !== undefined ? l.props : this.props.additionalLinesProps)} />
                    )}
                </g>
            );

            return (
                <div ref={node => this.svgContainerSelection = select(node)}
                     className={this.props.className} style={this.props.style}>
                    <svg id="cnt" ref={node => this.containerNode = node} height={this.props.height} width="100%">
                        <defs>
                            <clipPath id="plotRect">
                                <rect x="0" y="0" width={this.state.width - this.props.margin.left - this.props.margin.right} height={this.props.height - this.props.margin.top - this.props.margin.bottom} />
                            </clipPath>
                        </defs>
                        <g transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} clipPath="url(#plotRect)" >
                            {violinSelectionPaths}
                            {additionalLines}
                            <circle cx="0" cy="0" r="5" visibility="hidden" ref={node => this.highlightDotSelection1 = select(node)} />
                            <circle cx="0" cy="0" r="5" visibility="hidden" ref={node => this.highlightDotSelection2 = select(node)} />
                        </g>

                        {/* axes */}
                        <g ref={node => this.xAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.height - this.props.margin.bottom})`}/>
                        <text ref={node => this.xAxisLabelSelection = select(node)}
                              transform={`translate(${this.props.margin.left + (this.state.width - this.props.margin.left - this.props.margin.right) / 2}, ${this.props.height - 5})`} />
                        <g ref={node => this.yAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}/>
                        <text ref={node => this.yAxisLabelSelection = select(node)}
                              transform={`translate(${15}, ${this.props.margin.top + (this.props.height - this.props.margin.top - this.props.margin.bottom) / 2}) rotate(-90)`} />

                        {/* cursor line */}
                        {!this.state.zoomInProgress &&
                        <line ref={node => this.cursorSelection = select(node)} className={commonStyles.cursorLine} visibility="hidden"/>}

                        {/* status message */}
                        <text textAnchor="middle" x="50%" y="50%" fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                            {this.state.statusMsg}
                        </text>

                        {/* tooltip */}
                        {this.props.withTooltip && !this.state.zoomInProgress &&
                        <Tooltip
                            config={this.props.config}
                            containerHeight={this.props.height}
                            containerWidth={this.state.width}
                            mousePosition={this.state.mousePosition}
                            selection={this.state.tooltip}
                            signalSetsData={this.state.signalSetsData}
                            width={200}
                            contentRender={props => <TooltipContent {...props} tooltipFormat={this.props.tooltipFormat} />}
                        />}

                        {/* cursor area */}
                        <rect ref={node => this.cursorAreaSelection = select(node)}
                              x={this.props.margin.left} y={this.props.margin.top}
                              width={this.state.width - this.props.margin.left - this.props.margin.right}
                              height={this.props.height - this.props.margin.top - this.props.margin.bottom}
                              pointerEvents={"all"} cursor={"crosshair"} visibility={"hidden"}
                        />
                    </svg>
                </div>
            );
        }
    }
}
