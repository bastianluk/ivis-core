'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import * as d3Scale from "d3-scale";
import * as d3Format from "d3-format";
import * as d3Selection from "d3-selection";
import {select} from "d3-selection";
import * as d3Array from "d3-array";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {Tooltip} from "./Tooltip";
import {ConfigDifference, extentWithMargin, TimeIntervalDifference} from "./common";
import {PropType_d3Color, PropType_NumberInRange} from "../lib/CustomPropTypes";
import commonStyles from "./commons.scss";

function compareConfigs(conf1, conf2) {
    let diffResult = ConfigDifference.NONE;

    if (conf1.signalSets.length !== conf2.signalSets.length)
        return ConfigDifference.DATA_WITH_CLEAR;

    for (let i = 0; i < conf1.signalSets.length; i++)
        diffResult = Math.max(diffResult, compareSignalSetConfigs(conf1.signalSets[i], conf2.signalSets[i]));

    return diffResult;
}

function compareSignalSetConfigs(conf1, conf2) {
    if (conf1.cid !== conf2.cid ||
        conf1.sigCid !== conf2.sigCid ||
        conf1.tsSigCid !== conf2.tsSigCid) {
        return ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.fillColor !== conf2.fillColor ||
        conf1.enabled !== conf2.enabled ||
        conf1.label !== conf2.label) {
        return ConfigDifference.RENDER;
    }
    else return ConfigDifference.NONE;
}

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    intervalAccessMixin()
])
export class BoxPlot extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.dataAccessSession = new DataAccessSession();
        this.state = {
            signalSetsData: null,
            statusMsg: t('Loading...'),
            xScale: null,
            yScale: null,
            maxBoxWidth: 0,
        };

        this.resizeListener = () => {
            this.createChart();
        };
    }

    static propTypes = {
        config: PropTypes.shape({
            signalSets: PropTypes.arrayOf(PropTypes.shape({
                cid: PropTypes.string.isRequired,
                sigCid: PropTypes.string.isRequired,
                tsSigCid: PropTypes.string, // for use of TimeContext
                fillColor: PropType_d3Color(),
                label: PropTypes.string,
                enabled: PropTypes.bool,
                filter: PropTypes.object,
            })).isRequired
        }).isRequired,

        // percentiles
        topWhiskerPercentile: PropTypes.oneOfType([PropType_NumberInRange(0, 100), PropTypes.oneOf(["max"])]), // undefined = Q3 + 1.5 * IQR (default)
        topPercentile: PropType_NumberInRange(0, 100), // top of the box - Q3
        middlePercentile: PropType_NumberInRange(0, 100), // middle of the box - median
        bottomPercentile: PropType_NumberInRange(0, 100), // bottom of the box - Q1
        bottomWhiskerPercentile: PropTypes.oneOfType([PropType_NumberInRange(0, 100), PropTypes.oneOf(["min"])]),  // undefined = Q1 - 1.5 * IQR (default)

        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        maxBoxWidth: PropTypes.number,
        strokeWidth: PropTypes.number,
        medianLineWidth: PropTypes.number,
        whiskerLineWidth: PropTypes.number,
        whiskerTipLineWidth: PropTypes.number,
        whiskerTipLength: PropType_NumberInRange(0, 1), // length of the whisker tip line (along the x-axis) relative to the width of the box (1 = same width as box, 0 = no tip)
        dotRadius: PropTypes.number, // for outliers
        showMin: PropTypes.bool, // dot for the minimum (if bottomWhiskerPercentile is not "min")
        showMax: PropTypes.bool, // dot for the maximum (if topWhiskerPercentile is not "max")

        withCursor: PropTypes.bool,
        withTooltip: PropTypes.bool,
        tooltipFormat: PropTypes.func, /* gets state.tooltip which is an object of shape
         {
             y      // y-coordinate of the mouse
             box    // object with values (min, bottomWhisker, bottom, middle, top, topWhisker, max, label) for box under the mouse
         } */

        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.object,
        /**
         *  The getData function should return the data for the BoxPlot as an object of shape { signalSetsData, xExtent, yExtent }. The return value will be saved to the component's state.
         *  - signalSetsData is an array of object with shape { min, max, top, middle, bottom, topWhisker, bottomWhisker } (all the values are numbers - the y-coordinates
         *  - xExtent - array of strings with names for the boxes (displayed along the x-axis), should have same length as signalSetsData
         *  - yExtent - [minimum, maximum] of the y-axis
         **/
        getData: PropTypes.func,
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        maxBoxWidth: 100,
        strokeWidth: 1,
        medianLineWidth: 1,
        whiskerLineWidth: 1,
        whiskerTipLineWidth: 1,
        whiskerTipLength: 0.7,
        dotRadius: 5,
        showMin: true,
        showMax: true,

        topPercentile: 75,
        middlePercentile: 50,
        bottomPercentile: 25,

        withCursor: true,
        withTooltip: true,

        tooltipFormat: selection => `Y-coordinate: ${d3Format.format(".3r")(selection.y)}`,
    };

    componentDidMount() {
        window.addEventListener('resize', this.resizeListener);
        this.createChart(false);
        // noinspection JSIgnoredPromiseFromCall
        this.fetchData();
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        const t = this.props.t;

        let configDiff = compareConfigs(this.props.config, prevProps.config);

        // test if time interval changed
        const considerTs =  this.props.config.signalSets.some(setConf => !!setConf.tsSigCid);
        if (considerTs)
            configDiff = Math.max(configDiff, TimeIntervalDifference(this, prevProps));

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR) {
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
                 || prevProps.maxBoxWidth !== this.props.maxBoxWidth
                 || configDiff !== ConfigDifference.NONE;

            this.createChart(forceRefresh);
            this.prevContainerNode = this.containerNode;
        }
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.resizeListener);
    }

    getQueriesForSignalSet(signalSetConfig) {
        // filters
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
        if (signalSetConfig.filter)
            filter.children.push(signalSetConfig.filter);
        if (this.props.filter)
            filter.children.push(this.props.filter);

        // percentiles
        const percents = [this.props.topPercentile, this.props.middlePercentile, this.props.bottomPercentile]
        if (Number.isFinite(this.props.topWhiskerPercentile))
            percents.push(this.props.topWhiskerPercentile);
        if (Number.isFinite(this.props.bottomWhiskerPercentile))
            percents.push(this.props.bottomWhiskerPercentile);
        const aggs = [{
            sigCid: signalSetConfig.sigCid,
            agg_type: "percentiles",
            percents: percents,
            keyed: false
        }];

        // min and max
        const summary = {
            signals: {}
        };
        summary.signals[signalSetConfig.sigCid] = ["min", "max"];

        // return queries
        return [
            {
                type: "aggs",
                args: [signalSetConfig.cid, filter, aggs]
            },
            {
                type: "summary",
                args: [signalSetConfig.cid, filter, summary]
            }
        ];
    }

    /** Fetches new data for the chart, processes the results using prepareData method and updates the state accordingly, so the chart is redrawn */
    @withAsyncErrorHandler
    async fetchData() {
        if (typeof this.props.getData === "function") {
            this.setState(this.getData());
            return;
        }

        try {
            const queries = [];
            for (const signalSetConfig of this.props.config.signalSets) {
                queries.push(...this.getQueriesForSignalSet(signalSetConfig));
            }

            const results = await this.dataAccessSession.getLatestMixed(queries);

            if (results) { // Results is null if the results returned are not the latest ones
                this.setState(this.prepareData(results));
            }
        } catch (err) {
            this.setState({statusMsg: this.props.t("Error loading data.")});
            throw err;
        }
    }

    prepareData(results) {
        const signalSetsData = [];
        for (let i = 0; i < this.props.config.signalSets.length; i++) {
            const queriesForSignalSet = results.slice(2 * i, 2 * i + 2);
            signalSetsData.push(this.prepareDataForSignalSet(this.props.config.signalSets[i], queriesForSignalSet))
        }
        const xExtent = this.props.config.signalSets.map((s, index) => s.label || index);
        const yExtent = [
            d3Array.min(signalSetsData, d => Math.min(d.min, d.bottomWhisker)),
            d3Array.max(signalSetsData, d => Math.max(d.max, d.topWhisker))
        ];

        return {
            signalSetsData, xExtent, yExtent,
            statusMsg: "",
        };
    }

    prepareDataForSignalSet(signalSetConfig, queries) {
        const percentilesResults = queries[0][0];
        const summaryResults = queries[1];

        const min = summaryResults[signalSetConfig.sigCid].min;
        const max = summaryResults[signalSetConfig.sigCid].max;

        const top = percentilesResults.values.find(d => d.key === this.props.topPercentile).value;
        const middle = percentilesResults.values.find(d => d.key === this.props.middlePercentile).value;
        const bottom = percentilesResults.values.find(d => d.key === this.props.bottomPercentile).value;
        const IQR = top - bottom;

        // top whisker
        let topWhisker = top + 1.5 * IQR;
        if (this.props.topWhiskerPercentile === "max")
            topWhisker = max;
        else if (Number.isFinite(this.props.topWhiskerPercentile))
            topWhisker = percentilesResults.values.find(d => d.key === this.props.topWhiskerPercentile).value;

        // bottom whisker
        let bottomWhisker = bottom - 1.5 * IQR;
        if (this.props.bottomWhiskerPercentile === "min")
            bottomWhisker = min;
        else if (Number.isFinite(this.props.bottomWhiskerPercentile))
            bottomWhisker = percentilesResults.values.find(d => d.key === this.props.bottomWhiskerPercentile).value;

        return {
            min, max, top, middle, bottom, topWhisker, bottomWhisker
        }
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated.
     * All the 'createChart*' methods are called from here. */
    createChart(forceRefresh) {
        const signalSetsData = this.state.signalSetsData;

        const width = this.containerNode.getClientRects()[0].width;
        const widthChanged = this.state.width !== width;
        if (widthChanged) {
            this.setState({width});
        }

        if (!signalSetsData)
            return;
        if (!forceRefresh && !widthChanged)
            return;

        const ySize = this.props.height - this.props.margin.top - this.props.margin.bottom;
        const xSize = width - this.props.margin.left - this.props.margin.right;

        if (this.props.maxBoxWidth * (signalSetsData.length + 1) <= xSize) {
            if (this.props.maxBoxWidth !== this.state.maxBoxWidth)
                this.setState({maxBoxWidth: this.props.maxBoxWidth});
        }
        else
            if (this.state.maxBoxWidth !== xSize / (signalSetsData.length + 1))
                this.setState({ maxBoxWidth: xSize / (signalSetsData.length + 1) });

        //<editor-fold desc="Scales">
        const xScale = d3Scale.scalePoint()
            .domain(this.state.xExtent)
            .range([0, xSize])
            .padding(0.5);
        const xAxis = d3Axis.axisBottom(xScale)
            .tickSizeOuter(0);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.xAxisSelection.call(xAxis);
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");

        const yScale = d3Scale.scaleLinear()
            .domain(extentWithMargin(this.state.yExtent, 0.05))
            .range([ySize, 0]);
        const yAxis = d3Axis.axisLeft(yScale)
            .tickSizeOuter(0);
        if (this.props.yAxisTicksCount) xAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) xAxis.tickFormat(this.props.yAxisTicksFormat);
        this.yAxisSelection.call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");
        //</editor-fold>

        this.createChartCursor(xSize, ySize, xScale, yScale, signalSetsData);

        // re-render boxes with updated scales
        this.setState({ xScale, yScale });
    }

    /** Handles mouse movement to display cursor line.
     *  Called from this.createChart(). */
    createChartCursor(xSize, ySize, xScale, yScale, signalSetsData) {
        const self = this;

        const mouseMove = function () {
            const containerPos = d3Selection.mouse(self.containerNode);
            const y = containerPos[1] - self.props.margin.top;
            const x = containerPos[0] - self.props.margin.left;

            self.cursorSelection
                .attr('y1', containerPos[1])
                .attr('y2', containerPos[1])
                .attr('x1', self.props.margin.left)
                .attr('x2', xSize + self.props.margin.left)
                .attr('visibility', self.props.withCursor ? 'visible' : "hidden");

            // find which box is under the mouse
            let box = null;
            const halfStep = xScale.step() / 2;
            for (let i = 0; i < self.props.config.signalSets.length; i++) {
                const label = self.props.config.signalSets[i].label || i;
                const boxAreaLeftBorder = xScale(label) - halfStep;
                if (boxAreaLeftBorder < x) {
                    box = signalSetsData[i];
                    box.label = label;
                }
                else
                    break;
            }

            const mousePosition = {x: containerPos[0], y: containerPos[1]};
            const tooltip = {
                y: yScale.invert(y),
                box
            }

            self.setState({
                tooltip,
                mousePosition
            });
        };

        const mouseLeave = function () {
            self.cursorSelection.attr('visibility', 'hidden');
            self.setState({
                tooltip: null,
                mousePosition: null
            });
        }

        this.cursorAreaSelection
            .on('mouseenter', mouseMove)
            .on('mousemove', mouseMove)
            .on('mouseleave', mouseLeave);
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
            let boxes = [];
            if (this.state.xScale && this.state.yScale) {
                for (let i = 0; i < this.state.signalSetsData.length && i < this.props.config.signalSets.length; i++) {
                    const c = this.props.config.signalSets[i];
                    const d = this.state.signalSetsData[i];

                    const additionalValues = [];
                    if (this.props.showMax && this.props.topWhiskerPercentile !== "max")
                        additionalValues.push(this.state.yScale(d.max))
                    if (this.props.showMin &&this.props.bottomWhiskerPercentile !== "min")
                        additionalValues.push(this.state.yScale(d.min))

                    boxes.push(
                        <Box key={c.label}
                             x={this.state.xScale(c.label)}
                             width={this.state.maxBoxWidth}
                             top={this.state.yScale(d.top)}
                             middle={this.state.yScale(d.middle)}
                             bottom={this.state.yScale(d.bottom)}
                             topWhisker={this.state.yScale(d.topWhisker)}
                             bottomWhisker={this.state.yScale(d.bottomWhisker)}
                             additionalValues={additionalValues}
                             fillColor={c.fillColor || "none"}
                             BoxPlotProps={this.props}
                        />);
                }
            }

            return (
                <div className={this.props.className} style={this.props.style} >
                    <svg id="cnt" ref={node => this.containerNode = node} height={this.props.height} width="100%">
                        <g transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} >
                            {boxes}
                        </g>

                        {/* axes */}
                        <g ref={node => this.xAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.height - this.props.margin.bottom})`}/>
                        <text ref={node => this.xAxisLabelSelection = select(node)}
                              transform={`translate(${this.props.margin.left + (this.state.width - this.props.margin.left - this.props.margin.right) / 2}, ${this.props.height - 5})`} />
                        <g ref={node => this.yAxisSelection = select(node)} transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}/>
                        <text ref={node => this.yAxisLabelSelection = select(node)}
                              transform={`translate(${15}, ${this.props.margin.top + (this.props.height - this.props.margin.top - this.props.margin.bottom) / 2}) rotate(-90)`} />

                        {/* cursor line */}
                        <line ref={node => this.cursorSelection = select(node)} className={commonStyles.cursorLine} visibility="hidden"/>

                        {/* status message */}
                        <text textAnchor="middle" x="50%" y="50%" fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                            {this.state.statusMsg}
                        </text>

                        {/* tooltip */}
                        {this.props.withTooltip &&
                        <Tooltip
                            config={this.props.config}
                            containerHeight={this.props.height}
                            containerWidth={this.state.width}
                            mousePosition={this.state.mousePosition}
                            selection={this.state.tooltip}
                            width={200}
                            contentRender={props => props.selection ? this.props.tooltipFormat(props.selection) : null}
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

/**
 * Class for rendering boxes in BoxPlot. Should be placed inside SVG.
 */
@withComponentMixins([
    withErrorHandling,
])
export class Box extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        x: PropTypes.number.isRequired,
        width: PropTypes.number.isRequired,
        top: PropTypes.number.isRequired,
        middle: PropTypes.number.isRequired,
        bottom: PropTypes.number.isRequired,
        topWhisker: PropTypes.number,
        bottomWhisker: PropTypes.number,
        additionalValues: PropTypes.arrayOf(PropTypes.number),

        fillColor: PropType_d3Color(),
        BoxPlotProps: PropTypes.object,
    };

    render() {
        const p = this.props;
        const w = p.width / 2;
        const bp = this.props.BoxPlotProps;

        return (
            <g key={p.key} >
                <rect x={p.x - w} width={p.width} y={p.top} height={p.bottom - p.top} stroke="black" strokeWidth={bp.strokeWidth} fill={p.fillColor} />
                <line x1={p.x - w} x2={p.x + w} y1={p.middle} y2={p.middle} stroke="black" strokeWidth={bp.medianLineWidth}  />
                {p.topWhisker !== undefined && <>
                    <line x1={p.x} x2={p.x} y1={p.top} y2={p.topWhisker} stroke="black" strokeWidth={bp.whiskerLineWidth} />
                    <line x1={p.x - w * bp.whiskerTipLength} x2={p.x + w * bp.whiskerTipLength} y1={p.topWhisker} y2={p.topWhisker} stroke="black" strokeWidth={bp.whiskerTipLineWidth} />
                </>}
                {p.bottomWhisker !== undefined && <>
                    <line x1={p.x} x2={p.x} y1={p.bottom} y2={p.bottomWhisker} stroke="black" strokeWidth={bp.whiskerLineWidth}  />
                    <line x1={p.x - w * bp.whiskerTipLength} x2={p.x + w * bp.whiskerTipLength} y1={p.bottomWhisker} y2={p.bottomWhisker} stroke="black" strokeWidth={bp.whiskerTipLineWidth} />
                </>}
                {p.additionalValues &&
                    p.additionalValues.map(value =>
                        <circle key={value} cx={p.x} cy={value} r={bp.dotRadius} fill={p.fillColor !== "none" ? p.fillColor : "black"} />
                    )
                }
            </g>
        );
    }
}