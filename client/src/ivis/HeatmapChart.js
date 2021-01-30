'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import * as d3Scale from "d3-scale";
import * as d3Format from "d3-format";
import * as d3Selection from "d3-selection";
import {event as d3Event, select} from "d3-selection";
import * as d3Array from "d3-array";
import * as d3Color from "d3-color";
import * as d3Zoom from "d3-zoom";
import * as d3Brush from "d3-brush";
import * as d3Interpolate from "d3-interpolate";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {Tooltip} from "./Tooltip";
import {Icon} from "../lib/bootstrap-components";
import {AreZoomTransformsEqual, brushHandlesLeftRight, brushHandlesTopBottom, ConfigDifference, drawBars, getColorScale, setZoomTransform, TimeIntervalDifference, transitionInterpolate, WheelDelta, ZoomEventSources} from "./common";
import styles from "./CorrelationCharts.scss";
import {PropType_d3Color} from "../lib/CustomPropTypes";
import StatusMsg from "./StatusMsg";

function compareConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.sigSetCid !== conf2.sigSetCid || conf1.x_sigCid !== conf2.x_sigCid || conf1.y_sigCid !== conf2.y_sigCid || conf1.tsSigCid !== conf2.tsSigCid) {
        diffResult = ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.colors !== conf2.colors) {
        diffResult = ConfigDifference.RENDER;
    }

    return diffResult;
}

class TooltipContent extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        config: PropTypes.object.isRequired,
        signalSetsData: PropTypes.object,
        selection: PropTypes.object,
        tooltipFormat: PropTypes.func.isRequired
    };

    render() {
        if (this.props.selection) {
            const xStep = this.props.signalSetsData.step;
            const yStep = this.props.signalSetsData.buckets[0].step;
            const bucket = this.props.selection;

            let xDescription;
            if (xStep !== undefined) { // NUMBER
                const xKeyF = d3Format.format("." + d3Format.precisionFixed(xStep) + "f");
                xDescription = <div>X axis range: <Icon icon="chevron-left"/>{xKeyF(bucket.xKey)} <Icon icon="ellipsis-h"/> {xKeyF(bucket.xKey + xStep)}<Icon icon="chevron-right"/></div>
            } else { // KEYWORD
                xDescription = <div>X axis: {bucket.xKey}</div>;
            }

            let yDescription;
            if (yStep !== undefined) { // NUMBER
                const yKeyF = d3Format.format("." + d3Format.precisionFixed(yStep) + "f");
                yDescription = <div>Y axis range: <Icon icon="chevron-left"/>{yKeyF(bucket.key)} <Icon icon="ellipsis-h"/> {yKeyF(bucket.key + yStep)}<Icon icon="chevron-right"/></div>
            } else { // KEYWORD
                yDescription = <div>Y axis: {bucket.key}</div>;
            }

            const probF = d3Format.format(".2f");

            return (
                <div>
                    {xDescription}
                    {yDescription}
                    <div>{this.props.tooltipFormat(bucket)}</div>
                    <div>Frequency: {probF(bucket.prob * 100)}%</div>
                </div>
            );

        } else {
            return null;
        }
    }
}

const DataType = {
    NUMBER: 0,
    KEYWORD: 1
};

/** 2D histogram */
@withComponentMixins([
    withTranslation,
    withErrorHandling,
    intervalAccessMixin()
], ["getView", "setView"], ["processBucket", "prepareData", "getKeywordExtent", "getKeys"])
export class HeatmapChart extends Component {
    constructor(props) {
        super(props);

        const t = props.t;

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetData: null,
            statusMsg: t('Loading...'),
            width: undefined,
            height: 0,
            maxBucketCountX: 0,
            maxBucketCountY: 0,
            zoomTransform: d3Zoom.zoomIdentity,
            zoomYScaleMultiplier: 1,
        };

        this.brushBottom = null;
        this.brushLeft = null;
        this.zoom = null;
        this.lastZoomCausedByUser = false;
        this.ignoreZoomEvents = false;

        this.resizeListener = () => {
            this.createChart(true);
        };
    }

    static propTypes = {
        config: PropTypes.shape({
            sigSetCid: PropTypes.string.isRequired,
            x_sigCid: PropTypes.string.isRequired,
            y_sigCid: PropTypes.string.isRequired,
            colors: PropTypes.arrayOf(PropType_d3Color()),
            tsSigCid: PropTypes.string,
            metric_sigCid: PropTypes.string,
            metric_type: PropTypes.oneOf(["sum", "min", "max", "avg"])
        }).isRequired,
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        overviewBottomHeight: PropTypes.number,
        overviewBottomMargin: PropTypes.object,
        overviewBottomColor: PropType_d3Color(),
        overviewLeftWidth: PropTypes.number,
        overviewLeftMargin: PropTypes.object,
        overviewLeftColor: PropType_d3Color(),

        withTooltip: PropTypes.bool,
        withOverviewBottom: PropTypes.bool,
        withOverviewLeft: PropTypes.bool,
        withOverviewLeftBrush: PropTypes.bool,
        withOverviewBottomBrush: PropTypes.bool,
        withTransition: PropTypes.bool,
        withZoomX: PropTypes.bool,
        withZoomY: PropTypes.bool,
        tooltipFormat: PropTypes.func, // bucket => line in tooltip

        xAxisTicksCount: PropTypes.number,
        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        minStepX: PropTypes.number,
        minStepY: PropTypes.number,
        minRectWidth: PropTypes.number,
        minRectHeight: PropTypes.number,
        maxBucketCountX: PropTypes.number,
        maxBucketCountY: PropTypes.number,
        xMinValue: PropTypes.number,
        xMaxValue: PropTypes.number,
        yMinValue: PropTypes.number,
        yMaxValue: PropTypes.number,

        viewChangeCallback: PropTypes.func,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.object,
        processBucket: PropTypes.func, // see HeatmapChart.processBucket for reference
        prepareData: PropTypes.func, // see HeatmapChart.prepareData for reference
    };

    static defaultProps = {
        margin: {left: 40, right: 5, top: 5, bottom: 20},
        minRectWidth: 40,
        minRectHeight: 40,
        withTooltip: true,
        withOverviewBottom: true,
        withOverviewLeft: true,
        withOverviewLeftBrush: true,
        withOverviewBottomBrush: true,
        withTransition: true,
        withZoomX: true,
        withZoomY: true,
        tooltipFormat: bucket => `Count: ${bucket.count}`,

        xMinValue: NaN,
        xMaxValue: NaN,
        yMinValue: NaN,
        yMaxValue: NaN,

        zoomLevelMin: 1,
        zoomLevelMax: 4,

        overviewBottomHeight: 60,
        overviewBottomMargin: {top: 0, bottom: 20},
        overviewLeftWidth: 70,
        overviewLeftMargin: {left: 30, right: 0}
    };
    static defaultColors = ["#ffffff", "#1c70ff"]; // default value for props.config.colors

    componentDidMount() {
        window.addEventListener('resize', this.resizeListener);
        this.createChart(false, false);
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const t = this.props.t;

        let configDiff = compareConfigs(this.props.config, prevProps.config);

        // test if time interval changed
        const considerTs = !!this.props.config.tsSigCid;
        if (considerTs)
            configDiff = Math.max(configDiff, TimeIntervalDifference(this, prevProps));

        // test if limits changed
        if (!Object.is(prevProps.xMinValue, this.props.xMinValue) || !Object.is(prevProps.xMaxValue, this.props.xMaxValue) || !Object.is(prevProps.yMinValue, this.props.yMinValue) || !Object.is(prevProps.yMaxValue, this.props.yMaxValue)) {
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);
        }

        if (prevState.maxBucketCountX !== this.state.maxBucketCountX ||
            prevState.maxBucketCountY !== this.state.maxBucketCountY) {
            configDiff = Math.max(configDiff, ConfigDifference.DATA);
        }

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR) {
            this.setZoom(d3Zoom.zoomIdentity, 1); // reset zoom
            this.setState({
                statusMsg: t('Loading...')
            }, () => {
                // noinspection JSIgnoredPromiseFromCall
                this.fetchData();
            });
        } else if (configDiff === ConfigDifference.DATA) {
            // noinspection JSIgnoredPromiseFromCall
            this.fetchData();
        } else {
            const forceRefresh = this.prevContainerNode !== this.containerNode
                || prevState.signalSetData !== this.state.signalSetData
                || configDiff !== ConfigDifference.NONE;

            const updateZoom = !AreZoomTransformsEqual(prevState.zoomTransform, this.state.zoomTransform)
                || prevState.zoomYScaleMultiplier !== this.state.zoomYScaleMultiplier;

            this.createChart(forceRefresh, updateZoom);
            this.prevContainerNode = this.containerNode;
            if (updateZoom)
                this.callViewChangeCallback();
        }
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.resizeListener);
    }

    /** Fetches new data for the chart, processes the results using this.prepareData method and updates the state accordingly, so the chart is redrawn */
    @withAsyncErrorHandler
    async fetchData() {
        const config = this.props.config;

        let maxBucketCountX = this.props.maxBucketCountX || this.state.maxBucketCountX;
        let maxBucketCountY = this.props.maxBucketCountY || this.state.maxBucketCountY;
        if (maxBucketCountX > 0 && maxBucketCountY > 0) {
            this.setState({statusMsg: this.props.t('Loading...')});
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
                if (!isNaN(this.props.xMinValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.x_sigCid,
                        gte: this.props.xMinValue
                    });
                if (!isNaN(this.props.xMaxValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.x_sigCid,
                        lte: this.props.xMaxValue
                    });
                if (!isNaN(this.props.yMinValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.y_sigCid,
                        gte: this.props.yMinValue
                    });
                if (!isNaN(this.props.yMaxValue))
                    filter.children.push({
                        type: "range",
                        sigCid: config.y_sigCid,
                        lte: this.props.yMaxValue
                    });
                if (this.props.filter)
                    filter.children.push(this.props.filter);

                // filter by current zoom
                if (!AreZoomTransformsEqual(this.state.zoomTransform, d3Zoom.zoomIdentity) || this.state.zoomYScaleMultiplier !== 1) {
                    const scaleX = this.state.zoomTransform.k;
                    maxBucketCountX = Math.ceil(maxBucketCountX * scaleX);
                    const scaleY = this.state.zoomTransform.k * this.state.zoomYScaleMultiplier;
                    maxBucketCountY = Math.ceil(maxBucketCountY * scaleY);
                }

                let metrics;
                if (this.props.config.metric_sigCid && this.props.config.metric_type) {
                    metrics = {};
                    metrics[this.props.config.metric_sigCid] = [this.props.config.metric_type];
                }

                const results = await this.dataAccessSession.getLatestHistogram(config.sigSetCid, [config.x_sigCid, config.y_sigCid], [maxBucketCountX, maxBucketCountY], [this.props.minStepX, this.props.minStepY], filter, metrics);

                if (results) { // Results is null if the results returned are not the latest ones
                    const prepareData = this.props.prepareData || HeatmapChart.prepareData;
                    const [processedResults, xType, yType, xExtent, yExtent] = prepareData(this, results);
                    this.xType = xType;
                    this.yType = yType;
                    this.xExtent = xExtent;
                    this.yExtent = yExtent;
                    if (processedResults.xBucketsCount === 0 || processedResults.yBucketsCount === 0) {
                        this.brushBottom = null;
                        this.brushLeft = null;
                        this.zoom = null;
                        this.setState({
                            signalSetData: null,
                            statusMsg: this.props.t("No data.")
                        });
                        return;
                    }

                    this.setState({...processedResults, statusMsg: ""}, () => {
                        // call callViewChangeCallback when data new data without range filter are loaded as the xExtent and yExtent might got updated (even though this.state.zoomTransform is the same)
                        this.callViewChangeCallback();
                    });
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
     * @param {HistogramChart} self - this HistogramChart object
     * @param {object} bucket - the record from server; contains 'count' field, and also 'values' field if metrics were specified
     */
    static processBucket(self, bucket) {
        const config = self.props.config;
        if (config.metric_sigCid && config.metric_type) {
            if (!bucket.hasOwnProperty("values"))
                return 0;
            bucket.metric = bucket.values[config.metric_sigCid][config.metric_type];
            delete bucket.values;
            return bucket.metric;
        } else {
            return bucket.count;
        }
    }

    /**
     * Processes the results of queries and returns the data and xType, yType, xExtent and yExtent
     *
     * @param {HistogramChart} self - this HistogramChart object
     * @param {object} data - the data from server; contains at least 'buckets', 'step', 'offset' and 'agg_type' fields
     *
     * @returns {[object]} - tuple of 5 values:
     *
     *   - newState - data in form which can be directly passed to this.setState() function; should contain at least 'signalSetData', 'xBucketsCount', 'yBucketsCount' and 'maxProb' (frequency of highest bar) fields
     *   - xType, yType - numeric or keyword type of data along each axis (one of DataType)
     *   - xExtent, yExtent - [min, max] of x-axis and y-axis signal
     */
    static prepareData(self, data) {
        const props = self.props;
        let xType = data.agg_type === "histogram" ? DataType.NUMBER : DataType.KEYWORD;
        const xBucketsCount = data.buckets.length;
        let xExtent = null;
        let yExtent = null;

        if (xBucketsCount === 0)
            return [{
                signalSetData: data,
                xBucketsCount: 0,
                yBucketsCount: 0
            }, null, null, null, null];

        let yType = data.buckets[0].agg_type === "histogram" ? DataType.NUMBER : DataType.KEYWORD;
        let yBucketsCount;

        // compute xExtent
        if (xType === DataType.NUMBER) {
            let xMin = data.buckets[0].key;
            let xMax = data.buckets[xBucketsCount - 1].key + data.step;
            if (!isNaN(props.xMinValue)) xMin = props.xMinValue;
            if (!isNaN(props.xMaxValue)) xMax = props.xMaxValue;
            xExtent = [xMin, xMax];
        } else { // xType === DataType.KEYWORD
            xExtent = HeatmapChart.getKeys(data.buckets);
        }

        // compute yExtent
        if (yType === DataType.NUMBER) {
            yBucketsCount = data.buckets[0].buckets.length;
            if (yBucketsCount === 0)
                return [{
                    signalSetData: data,
                    xBucketsCount: 0,
                    yBucketsCount: 0,
                }, null, null, null, null];

            let yMin = data.buckets[0].buckets[0].key;
            let yMax = data.buckets[0].buckets[yBucketsCount - 1].key + data.buckets[0].step;
            if (!isNaN(props.yMinValue)) yMin = props.yMinValue;
            if (!isNaN(props.yMaxValue)) yMax = props.yMaxValue;
            yExtent = [yMin, yMax];
        } else { // yType === DataType.KEYWORD
            yExtent = HeatmapChart.getKeywordExtent(data.buckets);
            yExtent.sort((a, b) => a.localeCompare(b));
            // add missing inner buckets
            for (const bucket of data.buckets) {
                const innerKeys = HeatmapChart.getKeys(bucket.buckets);
                for (const key of yExtent)
                    if (innerKeys.indexOf(key) === -1) {
                        bucket.buckets.push({key: key, count: 0});
                    }
                // sort inner buckets so they are in same order in all outer buckets
                bucket.buckets.sort((a, b) => a.key.localeCompare(b.key));
            }
        }

        // process buckets
        let maxValue = 0;
        let totalValue = 0;
        const processBucket = props.processBucket || HeatmapChart.processBucket;
        for (const column of data.buckets)
            for (const bucket of column.buckets) {
                bucket.value = processBucket(self, bucket);
                if (bucket.value > maxValue)
                    maxValue = bucket.value;
                totalValue += bucket.value;
            }

        // calculate probabilities of buckets
        const rowProbs = data.buckets[0].buckets.map((b, i) => {
            return {key: b.key, prob: 0, index: i};
        });
        for (const column of data.buckets) {
            for (const [i, bucket] of column.buckets.entries()) {
                bucket.prob = bucket.value / totalValue;
                bucket.xKey = column.key;
                rowProbs[i].prob += bucket.prob;
            }
            column.prob = d3Array.sum(column.buckets, d => d.prob);
        }

        if (yType === DataType.KEYWORD) {
            // sort inner buckets by rowProbs
            rowProbs.sort((a, b) => b.prob - a.prob); // smallest to biggest prob
            const permuteKeys = rowProbs.map(d => d.index);
            yExtent = d3Array.permute(yExtent, permuteKeys);
            for (const column of data.buckets)
                column.buckets = d3Array.permute(column.buckets, permuteKeys);
        }

        return [{
            signalSetData: data,
            xBucketsCount, yBucketsCount,
            maxProb: maxValue / totalValue,
            rowProbs // colProbs are in signalSetData.buckets (outer buckets)
        }, xType, yType, xExtent, yExtent];
    }

    static getKeywordExtent(buckets_of_buckets) {
        const keys = new Set();
        for (const bucket of buckets_of_buckets)
            for (const inner_bucket of bucket.buckets)
                keys.add(inner_bucket.key);
        return [...keys];
    }

    static getKeys(buckets) {
        return buckets.map(bucket => bucket.key);
    }

    /** gets current xScale based on xType and current zoom */
    getXScale() {
        if (this.xType === DataType.NUMBER)
            return this.state.zoomTransform.rescaleX(d3Scale.scaleLinear()
                .domain(this.xExtent)
                .range([0, this.xSize])
            );
        else // this.xType === DataType.KEYWORD
            return d3Scale.scaleBand()
                .domain(this.xExtent)
                .range([0, this.xSize].map(d => this.state.zoomTransform.applyX(d)));
    }

    /** gets current yScale based on yType and current zoom */
    getYScale() {
        const zoomTransformY = this.state.zoomTransform.scale(this.state.zoomYScaleMultiplier);
        if (this.yType === DataType.NUMBER)
            return zoomTransformY.rescaleY(d3Scale.scaleLinear()
                .domain(this.yExtent)
                .range([this.ySize, 0])
            );
        else // this.yType === DataType.KEYWORD
            return d3Scale.scaleBand()
                .domain(this.yExtent)
                .range([this.ySize, 0].map(d => zoomTransformY.applyY(d)));
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated.
     * All the 'createChart*' methods are called from here. */
    createChart(forceRefresh, updateZoom) {
        const signalSetData = this.state.signalSetData;

        let width = this.containerNode.getClientRects()[0].width;
        const height = this.props.height;

        if (this.state.width !== width || this.state.height !== height) {
            if (this.props.withOverviewLeft && this.state.width === undefined)
                width -= this.props.overviewLeftWidth;
            const maxBucketCountX = Math.ceil(width / this.props.minRectWidth);
            const maxBucketCountY = Math.ceil(height / this.props.minRectHeight);

            this.setState({
                width,
                height,
                maxBucketCountX,
                maxBucketCountY
            });
        }

        const widthChanged = width !== this.renderedWidth;
        if (!forceRefresh && !widthChanged && !updateZoom) {
            return;
        }
        this.renderedWidth = width;

        if (!signalSetData) {
            return;
        }

        //<editor-fold desc="Scales">
        // x axis
        const xSize = width - this.props.margin.left - this.props.margin.right;
        this.xSize = xSize;
        const xScale = this.getXScale();
        this.xScale = xScale;
        const xAxis = d3Axis.axisBottom(xScale)
            .tickSizeOuter(0);
        if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.xAxisSelection.call(xAxis);
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");
        const xStep = signalSetData.step;
        const rectWidth = this.xType === DataType.NUMBER ?
            xScale(xStep) - xScale(0) :
            xScale.bandwidth();

        // y axis
        const ySize = height - this.props.margin.top - this.props.margin.bottom;
        this.ySize = ySize;
        const yScale = this.getYScale();
        this.yScale = yScale;
        const yAxis = d3Axis.axisLeft(yScale)
            .tickSizeOuter(0);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        this.yAxisSelection.call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");
        const yStep = signalSetData.buckets[0].step;
        const rectHeight = this.yType === DataType.NUMBER ?
            yScale(0) - yScale(yStep) :
            yScale.bandwidth();

        // color scale
        const colors = this.props.config.colors && this.props.config.colors.length >= 2 ? this.props.config.colors : HeatmapChart.defaultColors;
        const colorScale = getColorScale([0, this.state.maxProb], colors);
        //</editor-fold>

        this.drawRectangles(signalSetData, xScale, yScale, rectHeight, rectWidth, colorScale);

        if (this.props.withTooltip) {
            this.createChartCursor(signalSetData, xScale, yScale, rectHeight, rectWidth);
        }

        this.defaultBrushLeft = [0, this.ySize];
        this.overviewYScale = this.yType === DataType.NUMBER ?
            d3Scale.scaleLinear().domain(this.yExtent).range([this.ySize, 0]) :
            d3Scale.scaleBand().domain(this.yExtent).range([this.ySize, 0]);
        this.defaultBrushBottom = [0, this.xSize];
        this.overviewXScale = this.xType === DataType.NUMBER ? // keys
            d3Scale.scaleLinear().domain(this.xExtent).range([0, this.xSize]) :
            d3Scale.scaleBand().domain(this.xExtent).range([0, this.xSize]);
        if (this.props.withOverviewLeft)
            this.createChartOverviewLeft(this.state.rowProbs, this.overviewYScale, d3Color.color(this.props.overviewLeftColor || colors[colors.length - 1]));
        if (this.props.withOverviewBottom)
            this.createChartOverviewBottom(signalSetData.buckets, this.overviewXScale, d3Color.color(this.props.overviewBottomColor || colors[colors.length - 1]));

        if (this.props.withZoomX || this.props.withZoomY)
            this.createChartZoom(xSize, ySize);
        if (this.props.withOverviewLeft && this.props.withOverviewLeftBrush)
            this.createChartOverviewLeftBrush();
        if (this.props.withOverviewBottom && this.props.withOverviewBottomBrush)
            this.createChartOverviewBottomBrush();
    }

    /** Handles mouse movement to select the bin (for displaying its details in Tooltip, etc.).
     *  Called from this.createChart(). */
    createChartCursor(signalSetData, xScale, yScale, rectHeight, rectWidth) {
        const self = this;
        let selection, mousePosition;

        const selectPoints = function () {
            const containerPos = d3Selection.mouse(self.containerNode);
            const x = containerPos[0] - self.props.margin.left;
            const y = containerPos[1] - self.props.margin.top;

            let newSelectionColumn = null;
            for (const bucket of signalSetData.buckets) {
                if (xScale(bucket.key) <= x)
                    newSelectionColumn = bucket;
                else break;
            }

            let newSelection = null;
            const yCompensate = self.yType === DataType.NUMBER ? rectHeight : 0;
            if (newSelectionColumn)
                // noinspection JSUnresolvedVariable
                for (const innerBucket of newSelectionColumn.buckets) {
                    if (yScale(innerBucket.key) + rectHeight - yCompensate >= y)
                        newSelection = innerBucket;
                    else break;
                }

            if (selection !== newSelection) {
                self.highlightSelection
                    .selectAll('rect')
                    .remove();

                if (newSelection) {
                    // noinspection JSUnresolvedVariable
                    self.highlightSelection
                        .append('rect')
                        .attr('x', xScale(newSelection.xKey))
                        .attr('y', yScale(newSelection.key) - yCompensate)
                        .attr("width", rectWidth)
                        .attr("height", rectHeight)
                        .attr("fill", "none")
                        .attr("stroke", "black")
                        .attr("stroke-width", "2px");
                }
            }

            selection = newSelection;
            mousePosition = {x: containerPos[0], y: containerPos[1]};

            self.setState({
                selection,
                mousePosition
            });
        };

        this.cursorAreaSelection
            .on('mouseenter', selectPoints)
            .on('mousemove', selectPoints)
            .on('mouseleave', ::this.deselectPoints);
    }

    deselectPoints() {
        this.highlightSelection
            .selectAll('rect')
            .remove();

        this.setState({
            selection: null,
            mousePosition: null
        });
    };

    /** Draws rectangles for bins of data. */
    drawRectangles(signalSetData, xScale, yScale, rectHeight, rectWidth, colorScale) {
        const yCompensate = this.yType === DataType.NUMBER ? rectHeight : 0;

        const columns = this.columnsSelection
            .selectAll('g')
            .data(signalSetData.buckets);

        const rects = columns.enter()
            .append('g')
            .attr('key', d => d.key)
            .merge(columns)
            .selectAll('rect')
            .data(d => d.buckets);

        rects.enter()
            .append('rect')
            .merge(rects)
            .attr('key', d => d.key)
            .attr('x', d => xScale(d.xKey))
            .attr('y', d => yScale(d.key) - yCompensate)
            .attr("width", rectWidth)
            .attr("height", rectHeight)
            .attr("fill", d => colorScale(d.prob));

        rects.exit()
            .remove();
        columns.exit()
            .remove();
    }

    /** Handles zoom of the chart by user using d3-zoom.
     *  Called from this.createChart(). */
    createChartZoom(xSize, ySize) {
        // noinspection DuplicatedCode
        const self = this;

        const handleZoom = function () {
            if (self.ignoreZoomEvents) return;
            // noinspection JSUnresolvedVariable
            let newTransform = d3Event.transform;
            let newZoomYScaleMultiplier = self.state.zoomYScaleMultiplier;
            // check brush extents
            const [newBrushBottom, newBrushLeft, updated] = self.getBrushValuesFromZoomValues(newTransform, newZoomYScaleMultiplier);
            if (updated)
                [newTransform, newZoomYScaleMultiplier] = self.getZoomValuesFromBrushValues(newBrushBottom, newBrushLeft);

            // noinspection JSUnresolvedVariable
            if (d3Event.sourceEvent && d3Event.sourceEvent.type === "wheel" && self.props.withTransition) {
                self.lastZoomCausedByUser = true;
                self.ignoreZoomEvents = true;
                transitionInterpolate(select(self), self.state.zoomTransform, newTransform, (t, y) => {
                    setZoomTransform(self)(t, y);
                    self.moveBrush(t, y || newZoomYScaleMultiplier); // sourceEvent is "wheel"
                }, () => {
                    self.ignoreZoomEvents = false;
                    self.deselectPoints();
                    setZoomTransform(self)(newTransform, newZoomYScaleMultiplier);
                    if (self.zoom && !AreZoomTransformsEqual(newTransform, d3Zoom.zoomTransform(self.svgContainerSelection.node())))
                        self.zoom.transform(self.svgContainerSelection, newTransform);
                    self.moveBrush(newTransform, newZoomYScaleMultiplier);
                }, 150, self.state.zoomYScaleMultiplier, newZoomYScaleMultiplier);
            } else {
                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                    self.lastZoomCausedByUser = true;

                setZoomTransform(self)(newTransform, newZoomYScaleMultiplier);
                if (self.zoom && !AreZoomTransformsEqual(newTransform, d3Zoom.zoomTransform(self.svgContainerSelection.node())))
                    self.zoom.transform(self.svgContainerSelection, newTransform);

                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && d3Event.sourceEvent.type === "brush" && (d3Event.sourceEvent.target === self.brushLeft || d3Event.sourceEvent.target === self.brushBottom)) return;
                self.moveBrush(newTransform, newZoomYScaleMultiplier);
            }
        };

        const handleZoomEnd = function () {
            self.deselectPoints();
            self.setState({
                zoomInProgress: false
            });
        };
        const handleZoomStart = function () {
            self.setState({
                zoomInProgress: true
            });
        };

        const zoomExtent = [[0, 0], [xSize, ySize]];
        const translateExtent = [[0, 0], [xSize, ySize * this.state.zoomYScaleMultiplier]];
        let minZoom = Math.min(this.props.zoomLevelMin, this.props.zoomLevelMin / this.state.zoomYScaleMultiplier);
        if (this.props.withZoomY && !this.props.withZoomX)
            minZoom = this.props.zoomLevelMin / this.state.zoomYScaleMultiplier;
        else if (!this.props.withZoomY && this.props.withZoomX)
            minZoom = this.props.zoomLevelMin;

        const zoomExisted = this.zoom !== null;
        this.zoom = zoomExisted ? this.zoom : d3Zoom.zoom();
        this.zoom
            .scaleExtent([minZoom, this.props.zoomLevelMax])
            .translateExtent(translateExtent)
            .extent(zoomExtent)
            .filter(() => {
                if (d3Event.type === "wheel" && !d3Event.shiftKey)
                    return false;
                return !d3Event.ctrlKey && !d3Event.button && !this.state.brushInProgress;
            })
            .on("zoom", handleZoom)
            .on("end", handleZoomEnd)
            .on("start", handleZoomStart)
            .interpolate(d3Interpolate.interpolate)
            .wheelDelta(WheelDelta(2));
        this.svgContainerSelection.call(this.zoom);
        if (d3Zoom.zoomTransform(this.svgContainerSelection.node()).k < minZoom)
            this.svgContainerSelection.call(this.zoom.scaleTo, this.props.zoomLevelMin);
    }

    /** Updates overview brushes from zoom transform values. */
    moveBrush(transform, zoomYScaleMultiplier) {
        if (!this.defaultBrushBottom || !this.defaultBrushLeft) // no data
            return;
        const [newBrushBottom, newBrushLeft, _] = this.getBrushValuesFromZoomValues(transform, zoomYScaleMultiplier);
        if (newBrushBottom && this.brushBottom)
            this.overviewBottomBrushSelection.call(this.brushBottom.move, newBrushBottom);
        else
            this.brushBottomValues = newBrushBottom;
        if (newBrushLeft && this.brushLeft)
            this.overviewLeftBrushSelection.call(this.brushLeft.move, newBrushLeft);
        else
            this.brushLeftValues = newBrushLeft;
    };

    getBrushValuesFromZoomValues(transform, zoomYScaleMultiplier) {
        let updated = false;
        let newBrushBottom = this.defaultBrushBottom.map(transform.invertX, transform);
        const yTransform = transform.scale(zoomYScaleMultiplier);
        let newBrushLeft = this.defaultBrushLeft.map(yTransform.invertY, yTransform);

        if (this.props.withZoomX && this.props.withZoomY) {
            if (newBrushBottom[0] < this.defaultBrushBottom[0]) {
                newBrushBottom[0] = this.defaultBrushBottom[0];
                updated = true;
            }
            if (newBrushBottom[1] > this.defaultBrushBottom[1]) {
                newBrushBottom[1] = this.defaultBrushBottom[1];
                updated = true;
            }

            if (newBrushLeft[0] < this.defaultBrushLeft[0]) {
                newBrushLeft[0] = this.defaultBrushLeft[0];
                updated = true;
            }
            if (newBrushLeft[1] > this.defaultBrushLeft[1]) {
                newBrushLeft[1] = this.defaultBrushLeft[1];
                updated = true;
            }
        } else {
            updated = true;
            if (!this.props.withZoomX) {
                newBrushBottom = this.brushBottomValues || this.defaultBrushBottom;
            }
            if (!this.props.withZoomY) {
                newBrushLeft = this.brushLeftValues || this.defaultBrushLeft;
            }
        }
        return [newBrushBottom, newBrushLeft, updated];
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{xMin, xMax, yMin, yMax }} left, right, bottom, top boundary (numbers or strings based on the type of data on each axis)
     */
    getView() {
        const [xMin, xMax] = this.xScale.domain();
        const [yMin, yMax] = this.yScale.domain();
        return {xMin, xMax, yMin, yMax};
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels). If the axis data type is keyword (string), both boundary values are included.
     * @param xMin          left boundary of the visible region (in units of data on x-axis)
     * @param xMax          right boundary of the visible region (in units of data on x-axis)
     * @param yMin          bottom boundary of the visible region (in units of data on x-axis)
     * @param yMax          top boundary of the visible region (in units of data on x-axis)
     * @param source        the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser  tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     */
    setView(xMin, xMax, yMin, yMax, source, causedByUser = false) {
        if (source === this || this.state.signalSetData === null)
            return;

        if (xMin === undefined) xMin = this.xScale.domain()[0];
        if (xMax === undefined) xMax = this.xType === DataType.NUMBER ? this.xScale.domain()[1] : this.xScale.domain()[this.xScale.domain().length - 1];
        if (yMin === undefined) yMin = this.yScale.domain()[0];
        if (yMax === undefined) yMax = this.yType === DataType.NUMBER ? this.yScale.domain()[1] : this.yScale.domain()[this.yScale.domain().length - 1];

        if (this.overviewXScale(xMin) === undefined || this.overviewXScale(xMax) === undefined || this.overviewYScale(yMin) === undefined || this.overviewYScale(yMax) === undefined)
            throw new Error("Parameters out of range.");

        this.lastZoomCausedByUser = causedByUser;
        this.setZoomToLimits(xMin, xMax, yMin, yMax);
    }

    /** Sets zoom object (transform) to desired view boundaries. If the axis data type is keyword (string), both boundary values are included. */
    setZoomToLimits(xMin, xMax, yMin, yMax) {
        if (this.xType === DataType.NUMBER)
            this.brushBottomValues = [this.overviewXScale(xMin), this.overviewXScale(xMax)];
        else
            this.brushBottomValues = [this.overviewXScale(xMin), this.overviewXScale(xMax) + this.overviewXScale.bandwidth()];
        if (this.yType === DataType.NUMBER)
            this.brushLeftValues = [this.overviewYScale(yMax), this.overviewYScale(yMin)];
        else
            this.brushLeftValues = [this.overviewYScale(yMax), this.overviewYScale(yMin) + this.overviewYScale.bandwidth()];
        this.updateZoomFromBrush();
    }

    callViewChangeCallback() {
        if (typeof (this.props.viewChangeCallback) !== "function") return;

        this.props.viewChangeCallback(this, this.getView(), this.lastZoomCausedByUser);
    }

    /** Creates histogram to the left of the main chart without zoom to enable zoom navigation by d3-brush
     *  Called from this.createChart(). */
    createChartOverviewLeft(rowProbs, yScale, barColor) {
        //<editor-fold desc="Scales">
        const xSize = this.props.overviewLeftWidth - this.props.overviewLeftMargin.left - this.props.overviewLeftMargin.right;
        const maxProb = d3Array.max(rowProbs, d => d.prob);

        const xScale = d3Scale.scaleLinear() // probabilities
            .domain([0, maxProb])
            .range([0, xSize]);

        const yAxis = d3Axis.axisLeft(yScale)
            .tickSizeOuter(0);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        this.overviewLeftYAxisSelection.call(yAxis);
        //</editor-fold>

        this.drawHorizontalBars(rowProbs, this.overviewLeftBarsSelection, yScale, xScale, barColor);
    }

    /** Creates histogram below the main chart without zoom to enable zoom navigation by d3-brush
     *  Called from this.createChart(). */
    createChartOverviewBottom(colProbs, xScale, barColor) {
        //<editor-fold desc="Scales">
        const ySize = this.props.overviewBottomHeight - this.props.overviewBottomMargin.top - this.props.overviewBottomMargin.bottom;
        const maxProb = d3Array.max(colProbs, d => d.prob);

        const yScale = d3Scale.scaleLinear() // probabilities
            .domain([0, maxProb])
            .range([ySize, 0]);

        const xAxis = d3Axis.axisBottom(xScale)
            .tickSizeOuter(0);
        if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.overviewBottomXAxisSelection.call(xAxis);
        //</editor-fold>

        this.drawVerticalBars(colProbs, this.overviewBottomBarsSelection, xScale, yScale, barColor);
    }

    /** Creates d3-brush for left overview.
     *  Called from this.createChart(). */
    createChartOverviewLeftBrush() {
        const self = this;

        const xSize = this.props.overviewLeftWidth - this.props.overviewLeftMargin.left - this.props.overviewLeftMargin.right;
        const brushExisted = this.brushLeft !== null;
        this.brushLeft = brushExisted ? this.brushLeft : d3Brush.brushY();
        this.brushLeft
            .extent([[0, 0], [xSize, this.ySize]])
            .handleSize(20)
            .on("brush", function () {
                // noinspection JSUnresolvedVariable
                const sel = d3Event.selection;
                self.overviewLeftBrushSelection.call(brushHandlesTopBottom, sel, xSize);
                // noinspection JSUnresolvedVariable
                self.brushLeftValues = d3Event.selection;

                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && d3Event.sourceEvent.type !== "zoom" && d3Event.sourceEvent.type !== "brush" && d3Event.sourceEvent.type !== "end") { // ignore brush by zoom
                    if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                        self.lastZoomCausedByUser = true;
                    self.updateZoomFromBrush();
                }
            });

        this.overviewLeftBrushSelection
            .attr('pointer-events', 'all')
            .call(this.brushLeft);
        if (!brushExisted)
            this.overviewLeftBrushSelection.call(this.brushLeft.move, this.defaultBrushLeft);
        // ensure that brush is not outside the extent
        if (this.brushLeftValues && (this.brushLeftValues[0] < this.defaultBrushLeft[0] || this.brushLeftValues[1] > this.defaultBrushLeft[1]))
            this.overviewLeftBrushSelection.call(this.brushLeft.move, [Math.max(this.brushLeftValues[0], this.defaultBrushLeft[0]), Math.min(this.brushLeftValues[1], this.defaultBrushLeft[1])]);

        this.overviewLeftBrushSelection.select(".selection")
            .classed(styles.selection, true);
        this.overviewLeftBrushSelection.select(".overlay")
            .attr('pointer-events', 'none');
    }

    /** Creates d3-brush for bottom overview.
     *  Called from this.createChart(). */
    createChartOverviewBottomBrush() {
        const self = this;

        const ySize = this.props.overviewBottomHeight - this.props.overviewBottomMargin.top - this.props.overviewBottomMargin.bottom;
        const brushExisted = this.brushBottom !== null;
        this.brushBottom = brushExisted ? this.brushBottom : d3Brush.brushX();
        this.brushBottom
            .extent([[0, 0], [this.xSize, ySize]])
            .handleSize(20)
            .on("brush", function () {
                // noinspection JSUnresolvedVariable
                const sel = d3Event.selection;
                self.overviewBottomBrushSelection.call(brushHandlesLeftRight, sel, ySize);
                // noinspection JSUnresolvedVariable
                self.brushBottomValues = d3Event.selection;

                // noinspection JSUnresolvedVariable
                if (d3Event.sourceEvent && d3Event.sourceEvent.type !== "zoom" && d3Event.sourceEvent.type !== "brush" && d3Event.sourceEvent.type !== "end") { // ignore brush by zoom
                    if (d3Event.sourceEvent && ZoomEventSources.includes(d3Event.sourceEvent.type))
                        self.lastZoomCausedByUser = true;
                    self.updateZoomFromBrush();
                }
            });

        this.overviewBottomBrushSelection
            .attr('pointer-events', 'all')
            .call(this.brushBottom);
        if (!brushExisted)
            this.overviewBottomBrushSelection.call(this.brushBottom.move, this.defaultBrushBottom);
        // ensure that brush is not outside the extent
        if (this.brushBottomValues && (this.brushBottomValues[0] < this.defaultBrushBottom[0] || this.brushBottomValues[1] > this.defaultBrushBottom[1]))
            this.overviewBottomBrushSelection.call(this.brushBottom.move, [Math.max(this.brushBottomValues[0], this.defaultBrushBottom[0]), Math.min(this.brushBottomValues[1], this.defaultBrushBottom[1])]);

        this.overviewBottomBrushSelection.select(".selection")
            .classed(styles.selection, true);
        this.overviewBottomBrushSelection.select(".overlay")
            .attr('pointer-events', 'none');
    }

    getZoomValuesFromBrushValues(bottom, left) {
        if (!bottom) bottom = this.defaultBrushBottom;
        if (!left) left = this.defaultBrushLeft;
        const newXSize = bottom[1] - bottom[0];
        const newYSize = left[1] - left[0];
        const newXScaling = this.xSize / newXSize;
        const newYScaling = this.ySize / newYSize;
        const newZoomYScaleMultiplier = newYScaling / newXScaling;
        const transform = d3Zoom.zoomIdentity.scale(newXScaling).translate(-bottom[0], -left[0] * newZoomYScaleMultiplier);
        return [transform, newZoomYScaleMultiplier];
    }

    updateZoomFromBrush() {
        const [transform, newZoomYScaleMultiplier] = this.getZoomValuesFromBrushValues(this.brushBottomValues, this.brushLeftValues);

        this.setState({
            zoomYScaleMultiplier: newZoomYScaleMultiplier
        }, () => this.setZoom(transform, newZoomYScaleMultiplier));
    }

    /** Helper method to update zoom transform in state and zoom object. */
    setZoom(transform, zoomYScaleMultiplier) {
        if (this.zoom)
            this.svgContainerSelection.call(this.zoom.transform, transform);
        else {
            this.setState({zoomTransform: transform});
            this.moveBrush(transform, zoomYScaleMultiplier);
        }
    }

    drawVerticalBars(data, barsSelection, keyScale, probScale, barColor) {
        const ySize = probScale.range()[0];
        const barWidth = (keyScale.range()[1] - keyScale.range()[0]) / data.length;

        drawBars(data, barsSelection,
            d => keyScale(d.key),
            d => probScale(d.prob),
            barWidth,
            d => ySize - probScale(d.prob),
            barColor,
            d => d.key);
    }

    drawHorizontalBars(data, barsSelection, keyScale, probScale, barColor) {
        const barHeight = (keyScale.range()[0] - keyScale.range()[1]) / data.length;
        const yCompensate = this.yType === DataType.NUMBER ? barHeight : 0;

        drawBars(data, barsSelection,
            0,
            d => keyScale(d.key) - yCompensate,
            d => probScale(d.prob),
            barHeight,
            barColor,
            d => d.key);
    }

    render() {
        if (!this.state.signalSetData) {
            return (
                <svg ref={node => this.containerNode = node} height={this.props.height} width="100%"
                     className={this.props.className} style={this.props.style}>
                    <StatusMsg>
                        {this.state.statusMsg}
                    </StatusMsg>
                </svg>
            );

        } else {

            return (
                <div className={this.props.className} style={this.props.style}>
                    {this.props.withOverviewLeft &&
                    <svg id="overview_left"
                         height={this.props.height}
                         width={this.props.overviewLeftWidth}>
                        <g transform={`translate(${this.props.overviewLeftMargin.left}, ${this.props.margin.top})`}>
                            <g ref={node => this.overviewLeftBarsSelection = select(node)}/>
                        </g>
                        <g ref={node => this.overviewLeftYAxisSelection = select(node)}
                           transform={`translate(${this.props.overviewLeftMargin.left}, ${this.props.margin.top})`}/>
                        <g ref={node => this.overviewLeftBrushSelection = select(node)}
                           transform={`translate(${this.props.overviewLeftMargin.left}, ${this.props.margin.top})`}
                           className={styles.brush}/>
                    </svg>}
                    <div ref={node => this.svgContainerSelection = select(node)} className={styles.touchActionNone}
                         style={{
                             width: this.props.withOverviewLeft ? `calc(100% - ${this.props.overviewLeftWidth}px)` : "100%",
                             height: this.props.height,
                             display: "inline-block"
                         }}>
                        <svg id="cnt" ref={node => this.containerNode = node} height={"100%"} width={"100%"}>
                            <defs>
                                <clipPath id="plotRect">
                                    <rect x="0" y="0"
                                          width={this.state.width - this.props.margin.left - this.props.margin.right}
                                          height={this.props.height - this.props.margin.top - this.props.margin.bottom}/>
                                </clipPath>
                                <clipPath id="leftAxis">
                                    <rect x={-this.props.margin.left + 1} y={0} width={this.props.margin.left}
                                          height={this.props.height - this.props.margin.top - this.props.margin.bottom + 6} /* 6 is default size of axis ticks, so we can add extra space in the bottom left corner for this axis and still don't collide with the other axis. Thanks to this, the first tick text should not be cut in half. */ />
                                </clipPath>
                                <clipPath id="bottomAxis">
                                    <rect x={-6} y={0}
                                          width={this.state.width - this.props.margin.left - this.props.margin.right + 6}
                                          height={this.props.margin.bottom} /* same reason for 6 as above */ />
                                </clipPath>
                            </defs>
                            <g transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}
                               clipPath="url(#plotRect)">
                                <g ref={node => this.columnsSelection = select(node)}/>
                                {!this.state.zoomInProgress &&
                                <g ref={node => this.highlightSelection = select(node)}/>}
                            </g>

                            {/* axes */}
                            <g ref={node => this.xAxisSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.height - this.props.margin.bottom})`}
                               clipPath="url(#bottomAxis)"/>
                            <text ref={node => this.xAxisLabelSelection = select(node)}
                                  transform={`translate(${this.props.margin.left + (this.state.width - this.props.margin.left - this.props.margin.right) / 2}, ${this.props.height - 5})`}/>
                            <g ref={node => this.yAxisSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}
                               clipPath="url(#leftAxis)"/>
                            <text ref={node => this.yAxisLabelSelection = select(node)}
                                  transform={`translate(${15}, ${this.props.margin.top + (this.props.height - this.props.margin.top - this.props.margin.bottom) / 2}) rotate(-90)`}/>

                            <StatusMsg>
                                {this.state.statusMsg}
                            </StatusMsg>
                            {this.props.withTooltip && !this.state.zoomInProgress &&
                            <Tooltip
                                config={this.props.config}
                                signalSetsData={this.state.signalSetData}
                                containerHeight={this.props.height}
                                containerWidth={this.state.width}
                                mousePosition={this.state.mousePosition}
                                selection={this.state.selection}
                                contentRender={props => <TooltipContent {...props} tooltipFormat={this.props.tooltipFormat}/>}
                                width={250}
                            />
                            }
                            {/* cursor area */}
                            <rect ref={node => this.cursorAreaSelection = select(node)}
                                  x={this.props.margin.left} y={this.props.margin.top}
                                  width={this.state.width - this.props.margin.left - this.props.margin.right}
                                  height={this.props.height - this.props.margin.top - this.props.margin.bottom}
                                  pointerEvents={"all"} cursor={"crosshair"} visibility={"hidden"}
                            />
                        </svg>
                    </div>
                    {this.props.withOverviewBottom &&
                    <svg id="overview_bottom"
                         style={{marginLeft: this.props.withOverviewLeft ? this.props.overviewLeftWidth : 0}}
                         height={this.props.overviewBottomHeight}
                         width={this.props.withOverviewLeft ? `calc(100% - ${this.props.overviewLeftWidth}px)` : "100%"}>
                        <g transform={`translate(${this.props.margin.left}, ${this.props.overviewBottomMargin.top})`}>
                            <g ref={node => this.overviewBottomBarsSelection = select(node)}/>
                        </g>
                        <g ref={node => this.overviewBottomXAxisSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewBottomHeight - this.props.overviewBottomMargin.bottom})`}/>
                        <g ref={node => this.overviewBottomBrushSelection = select(node)}
                           transform={`translate(${this.props.margin.left}, ${this.props.overviewBottomMargin.top})`}
                           className={styles.brush}/>
                    </svg>}
                </div>
            );
        }
    }
}
