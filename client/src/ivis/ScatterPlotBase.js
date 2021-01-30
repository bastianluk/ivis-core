'use strict';

import React, {Component} from "react";
import * as d3Axis from "d3-axis";
import * as d3Scale from "d3-scale";
import * as d3Array from "d3-array";
import * as d3Selection from "d3-selection";
import {event as d3Event, select} from "d3-selection";
import * as d3Brush from "d3-brush";
import * as d3Regression from "d3-regression";
import * as d3Shape from "d3-shape";
import * as d3Zoom from "d3-zoom";
import * as d3Interpolate from "d3-interpolate";
import * as d3Color from "d3-color";
import * as d3Scheme from "d3-scale-chromatic";
import * as d3Format from "d3-format";
import {intervalAccessMixin} from "./TimeContext";
import {DataAccessSession} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {Tooltip} from "./Tooltip";
import {Button, CheckBox, Form, InputField, withForm} from "../lib/form";
import styles from "./CorrelationCharts.scss";
import {ActionLink, Icon} from "../lib/bootstrap-components";
import {AreZoomTransformsEqual, ConfigDifference, distance, extentWithMargin, getColorScale, getExtent, isInExtent, isSignalVisible, ModifyColorCopy, setZoomTransform, TimeIntervalDifference, transitionInterpolate, WheelDelta, ZoomEventSources} from "./common";
import {PropType_d3Color_Required} from "../lib/CustomPropTypes";
import {dotShapes, dotShapeNames} from "./dot_shapes";
import {withPageHelpers} from "../lib/page-common";

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

    if (conf1.cid !== conf2.cid ||
        conf1.x_sigCid !== conf2.x_sigCid ||
        conf1.y_sigCid !== conf2.y_sigCid ||
        conf1.dotSize_sigCid !== conf2.dotSize_sigCid ||
        conf1.colorContinuous_sigCid !== conf2.colorContinuous_sigCid ||
        conf1.colorDiscrete_sigCid !== conf2.colorDiscrete_sigCid ||
        conf1.tsSigCid !== conf2.tsSigCid) {
        diffResult = ConfigDifference.DATA_WITH_CLEAR;
    } else if (conf1.color !== conf2.color ||
               conf1.enabled !== conf2.enabled ||
               conf1.label !== conf2.label ||
               conf1.x_label !== conf2.x_label ||
               conf1.y_label !== conf2.y_label ||
               conf1.dotSize_label !== conf2.dotSize_label ||
               conf1.color_label !== conf2.color_label ||
               conf1.regressions !== conf2.regressions) {
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
        selection: PropTypes.object,
        labels: PropTypes.object.isRequired
    };

    static defaultLabels = {
        label_format: (label, value) => {
            if (value !== undefined)
                return value;
            if (label !== undefined)
                return label;
            return null;
        },
        x_label: "x",
        y_label: "y",
        dotSize_label: "size",
        color_label: "color",
    };

    static labelPropNames = ["x_label", "y_label", "dotSize_label", "color_label"];

    getLabels(cid) {
        const datum = this.props.selection[cid];
        const labels = this.props.labels[cid];
        const defaultLabels = TooltipContent.defaultLabels;

        // use default labels for those not specified in props
        for (const l of [...TooltipContent.labelPropNames, "label_format"])
            if (labels[l] === undefined)
                labels[l] = defaultLabels[l];

        // convert each label to a function which takes data value and returns label string
        for (const l of [...TooltipContent.labelPropNames, "label_format"]) {
            if (labels[l] === null) // if label is specified to null, don't render it
                labels[l] = () => null;
            else if (typeof labels[l] === "string") { // if label is specified as string, convert it to function
                const label_string = labels[l];
                labels[l] = (val) => {
                    if (val === undefined) // if the value doesn't exist, return null (-> don't render the label)
                        return null;
                    else
                        return label_string + ": " + val;
                };
            }
        }

        return {
            label: labels.label_format(labels.label !== undefined ? labels.label : cid, datum.label),
            x_label: labels.x_label(datum.x),
            y_label: labels.y_label(datum.y),
            dotSize_label: labels.dotSize_label(datum.s),
            color_label: labels.color_label(datum.d || datum.c),
        }
    }

    render() {
        if (this.props.selection) {
            let tooltipHTML = [];
            for (let cid in this.props.selection) {
                if (this.props.selection[cid]) {
                    const labels = this.getLabels(cid);
                    tooltipHTML.push((
                        <div key={cid}>
                            <div><b>{labels.label}</b></div>
                            {TooltipContent.labelPropNames.map(l => {
                                if (labels[l] !== null)
                                    return <div key={l}>{labels[l]}</div>;
                            })}
                        </div>
                    ));
                }
            }
            return tooltipHTML;
        } else {
            return null;
        }
    }
}

@withComponentMixins([
    withTranslation,
    withForm
])
class ScatterPlotToolbar extends Component {
    constructor(props) {
        super(props);

        this.state = {
            opened: false
        };

        this.initForm();
    }

    static propTypes = {
        resetZoomClick: PropTypes.func.isRequired,
        zoomOutClick: PropTypes.func,
        zoomInClick: PropTypes.func,
        reloadDataClick: PropTypes.func.isRequired,
        brushClick: PropTypes.func,
        setSettings: PropTypes.func,
        setLimits: PropTypes.func,
        withSettings: PropTypes.bool.isRequired,
        settings: PropTypes.object,
        brushInProgress: PropTypes.bool
    };

    static defaultProps = {
        withSettings: false
    };

    componentDidMount() {
        this.updateFormValues();
    }

    componentDidUpdate(prevProps, prevState, snapshot) {
        if (this.props.settings !== prevProps.settings)
            this.updateFormValues();
    }

    updateFormValues() {
        let settings = this.props.settings;
        if (settings.maxDotCount < 0)
            settings.maxDotCount = "";
        if (isNaN(settings.xMin)) settings.xMin = "";
        if (isNaN(settings.xMax)) settings.xMax = "";
        if (isNaN(settings.yMin)) settings.yMin = "";
        if (isNaN(settings.yMax)) settings.yMax = "";

        this.populateFormValues(settings);
    }

    localValidateFormValues(state) {
        this.validateNumber(state, "maxDotCount", "Maximum number of dots must be empty or a number.");
        this.validateNumber(state, "xMin","X axis minimum must be empty or a number.");
        this.validateNumber(state, "xMax","Y axis maximum must be empty or a number.");
        this.validateNumber(state, "yMin","Y axis minimum must be empty or a number.");
        this.validateNumber(state, "yMax","Y axis maximum must be empty or a number.");
    }

    validateNumber(state, numberFormId, errorMessage) {
        const t = this.props.t;
        const num = state.getIn([numberFormId, 'value']);
        if (num !== undefined && num !== "" && isNaN(num)) {
            state.setIn([numberFormId, 'error'], t(errorMessage));
        }
        else
            state.setIn([numberFormId, 'error'], null);
    }

    async submitForm() {
        if (this.isFormWithoutErrors()) {
            let maxDotCount = this.getFormValue('maxDotCount');
            let xMin = this.getFormValue("xMin");
            let xMax = this.getFormValue("xMax");
            let yMin = this.getFormValue("yMin");
            let yMax = this.getFormValue("yMax");
            const withTooltip = this.getFormValue('withTooltip');

            if (maxDotCount === undefined || maxDotCount === "")
                maxDotCount = -1;
            else
                maxDotCount = parseInt(maxDotCount);
            xMin = parseFloat(xMin);
            xMax = parseFloat(xMax);
            yMin = parseFloat(yMin);
            yMax = parseFloat(yMax);

            this.props.setSettings(maxDotCount, withTooltip);
            this.props.setLimits(xMin, xMax, yMin, yMax, this, true, true); // last two args: causedByUser, withTransition

            this.setState({
                opened: false
            });

        } else {
            this.showFormValidation();
        }
    }

    render() {
        const t = this.props.t;

        return (
            <div className={`card ${this.state.opened ? styles.scatterPlotToolbarOpened : styles.scatterPlotToolbar}`}>
                <div className="card-header" /*onClick={() => this.setState({opened: !this.state.opened})}*/>
                    <div className={styles.headingButtons}>
                        {this.props.zoomOutClick && <ActionLink onClickAsync={async () => this.props.zoomOutClick()}><Icon icon="search-minus" title={t('Zoom out')}/></ActionLink>}
                        {this.props.zoomInClick && <ActionLink onClickAsync={async () => this.props.zoomInClick()}><Icon icon="search-plus" title={t('Zoom in')}/></ActionLink>}
                        <ActionLink onClickAsync={async () => this.props.reloadDataClick()}><Icon icon="redo" title={t('Reload data')}/></ActionLink>
                        {this.props.brushClick &&
                        <ActionLink onClickAsync={async () => this.props.brushClick()}
                                    className={this.props.brushInProgress ? styles.active : ""}>
                            <Icon icon="edit"
                                  title={this.props.brushInProgress ? t('Cancel selection') : t('Select area')}/>
                        </ActionLink>}
                        <ActionLink onClickAsync={async () => this.props.resetZoomClick()}><Icon icon="expand" title={t('Reset zoom')}/></ActionLink>
                        {this.props.withSettings &&
                        <ActionLink onClickAsync={async () => this.setState({opened: !this.state.opened})}><Icon icon="sliders-h" title={t('Open settings')}/></ActionLink>}
                    </div>
                </div>
                {this.state.opened && this.props.withSettings &&
                <div className="card-body">
                    <Form stateOwner={this} onSubmitAsync={::this.submitForm} format="wide">
                        <InputField id="maxDotCount" label={t('Maximum number of dots')}/>
                        <CheckBox id={"withTooltip"} label={t("Show tooltip")}/>
                        <InputField id="xMin" label={t('X axis minimum')}/>
                        <InputField id="xMax" label={t('X axis maximum')}/>
                        <InputField id="yMin" label={t('Y axis minimum')}/>
                        <InputField id="yMax" label={t('Y axis maximum')}/>
                        <Button type="submit" className="btn-primary" label={t('Apply')}/>
                    </Form>
                </div>
                }
            </div>
        );
    }
}

/**
 * Common class for ScatterPlot, BubblePlot (and possibly other) components
 */
@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withPageHelpers,
    intervalAccessMixin()
], ["setMaxDotCount", "setWithTooltip", "getView", "setView"], ["getQueries", "getQueriesForSignalSet", "prepareData", "computeExtents", "processDocs", "filterData", "drawChart", "drawDots", "drawHighlightDot"])
export class ScatterPlotBase extends Component {
    //<editor-fold desc="React methods, constructor">
    constructor(props) {
        super(props);

        const t = props.t;
        this.dataAccessSession = new DataAccessSession();
        this.resizeListener = () => {
            this.createChart();
        };
        /** labels used for Tooltip */
        this.labels = {};
        this.globalRegressions = [];
        this.regressions = [];
        this.lastZoomCausedByUser = false;

        this.zoom = null;

        this.state = {
            signalSetsData: null, // data from last request
            globalSignalSetsData: null, // data from request without range filters (completely zoomed out)
            statusMsg: t('Loading...'),
            width: 0,
            selections: null,
            zoomTransform: d3Zoom.zoomIdentity,
            zoomYScaleMultiplier: 1,
            zoomInProgress: false,
            brushInProgress: false,
            xMin: props.xMinValue,
            xMax: props.xMaxValue,
            yMin: props.yMinValue,
            yMax: props.yMaxValue,
            withTooltip: props.withTooltip,
            maxDotCount: props.maxDotCount,
            noData: true
        };
    }

    static propTypes = {
        config: PropTypes.shape({
            signalSets: PropTypes.arrayOf(PropTypes.shape({
                cid: PropTypes.string.isRequired,
                x_sigCid: PropTypes.string.isRequired,
                y_sigCid: PropTypes.string.isRequired,
                dotSize_sigCid: PropTypes.string, // used for BubblePlot
                colorContinuous_sigCid: PropTypes.string,
                colorDiscrete_sigCid: PropTypes.string,
                tsSigCid: PropTypes.string, // for use of TimeContext
                label_sigCid: PropTypes.string,
                color: PropTypes.oneOfType([PropType_d3Color_Required(), PropTypes.arrayOf(PropType_d3Color_Required())]),
                label: PropTypes.string,
                enabled: PropTypes.bool,
                dotShape: PropTypes.oneOf(dotShapeNames), // default = ScatterPlotBase.dotShape
                dotSize: PropTypes.number, // default = props.dotSize; used when dotSize_sigCid is not specified
                globalDotShape: PropTypes.oneOf(dotShapeNames), // default = ScatterPlotBase.defaultGlobalDotShape
                getGlobalDotColor: PropTypes.func, // color modification for global dots (default: lower opacity)
                tooltipLabels: PropTypes.shape({
                    label_format: PropTypes.func,
                    x_label: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
                    y_label: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
                    dotSize_label: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
                    color_label: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
                }),
                regressions: PropTypes.arrayOf(PropTypes.shape({
                    type: PropTypes.string.isRequired,
                    color: PropTypes.oneOfType([PropType_d3Color_Required(), PropTypes.arrayOf(PropType_d3Color_Required())]),
                    createRegressionForEachColor: PropTypes.bool, // default: false
                    bandwidth: PropTypes.number,    // for LOESS
                    order: PropTypes.number         // for polynomial
                })),
                filter: PropTypes.object,
            })).isRequired
        }).isRequired,

        maxDotCount: PropTypes.number, // prop will get copied to state in constructor, changing it later will not update it, use setMaxDotCount method to update it
        dotSize: PropTypes.number,
        minDotSize: PropTypes.number, // for BubblePlot
        maxDotSize: PropTypes.number, // for BubblePlot
        highlightDotSize: PropTypes.number, // radius multiplier
        colors: PropTypes.arrayOf(PropType_d3Color_Required()), // if specified, uses same cScale for all signalSets that have color*_sigCid and config.signalSets[*].color is not array

        xMinValue: PropTypes.number,
        xMaxValue: PropTypes.number,
        yMinValue: PropTypes.number,
        yMaxValue: PropTypes.number,
        minDotSizeValue: PropTypes.number, // for BubblePlot
        maxDotSizeValue: PropTypes.number, // for BubblePlot
        minColorValue: PropTypes.number,
        maxColorValue: PropTypes.number,
        colorValues: PropTypes.array,

        xAxisExtentFromSampledData: PropTypes.bool, // whether xExtent should be [min, max] of the whole signal or only of the returned docs
        yAxisExtentFromSampledData: PropTypes.bool,
        updateColorOnZoom: PropTypes.bool,
        updateSizeOnZoom: PropTypes.bool, // for BubblePlot

        xAxisTicksCount: PropTypes.number,
        xAxisTicksFormat: PropTypes.func,
        xAxisLabel: PropTypes.string,
        yAxisTicksCount: PropTypes.number,
        yAxisTicksFormat: PropTypes.func,
        yAxisLabel: PropTypes.string,

        height: PropTypes.number.isRequired,
        margin: PropTypes.object,

        withBrush: PropTypes.bool,
        withCursor: PropTypes.bool,
        withTooltip: PropTypes.bool, // prop will get copied to state in constructor, changing it later will not update it, use setWithTooltip to update it
        withZoom: PropTypes.bool,
        withTransition: PropTypes.bool,
        withRegressionCoefficients: PropTypes.bool,
        withToolbar: PropTypes.bool,
        withSettings: PropTypes.bool,
        withAutoRefreshOnBrush: PropTypes.bool,

        viewChangeCallback: PropTypes.func,

        zoomLevelMin: PropTypes.number,
        zoomLevelMax: PropTypes.number,
        zoomLevelStepFactor: PropTypes.number,

        className: PropTypes.string,
        style: PropTypes.object,

        filter: PropTypes.oneOfType([PropTypes.object, PropTypes.func]),
        getQueries: PropTypes.func, // see ScatterPlotBase.getQueries for reference
        getQueriesForSignalSet: PropTypes.func, // see ScatterPlotBase.getQueriesForSignalSet for reference
        prepareData: PropTypes.func, // see ScatterPlotBase.prepareData for reference
        computeExtents: PropTypes.func, // see ScatterPlotBase.computeExtents for reference
        processDocs: PropTypes.func, // see ScatterPlotBase.processDocs for reference
        filterData: PropTypes.func, // see ScatterPlotBase.filterData for reference
        drawChart: PropTypes.func, // see ScatterPlotBase.drawChart for reference
        drawDots: PropTypes.func, // see ScatterPlotBase.drawDots for reference
        drawHighlightDot: PropTypes.func, // see ScatterPlotBase.drawDots for reference
    };

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        withBrush: true,
        withCursor: true,
        withTooltip: true,
        withZoom: true,
        withTransition: true,
        withRegressionCoefficients: true,
        withToolbar: true,
        withSettings: true,
        withAutoRefreshOnBrush: true,

        xMinValue: NaN,
        xMaxValue: NaN,
        yMinValue: NaN,
        yMaxValue: NaN,

        dotSize: 5,
        minDotSize: 2,
        maxDotSize: 14,
        highlightDotSize: 1.2,
        xAxisExtentFromSampledData: false,
        yAxisExtentFromSampledData: false,
        updateColorOnZoom: false,
        updateSizeOnZoom: false,
        maxDotCount: 100,
        zoomLevelMin: 1,
        zoomLevelMax: 10,
        zoomLevelStepFactor: 1.5,
        colors: d3Scheme.schemeCategory10
    };

    static defaultDotShape = "circle";
    static defaultGlobalDotShape = "circle_empty";
    static defaultGetGlobalDotColor = color => { color.opacity *= 0.5; return color; };

    componentDidMount() {
        window.addEventListener('resize', this.resizeListener);
        window.addEventListener('keydown', ::this.keydownListener);
        window.addEventListener('keyup', ::this.keyupListener);
        this.createChart(false);
        // noinspection JSIgnoredPromiseFromCall
        this.fetchData();
    }

    keydownListener(event) {
        if (event.key === "Control" && !this.state.brushInProgress)
            this.setState({brushInProgress: true});
    }
    keyupListener(event) {
        if (event.key === "Control" && this.state.brushInProgress && !this.state.zoomInProgress)
            this.setState({brushInProgress: false});
    }

    /** Update and redraw the chart based on changes in React props and state */
    componentDidUpdate(prevProps, prevState) {
        let configDiff = compareConfigs(this.props.config, prevProps.config);

        if (this.state.maxDotCount !== prevState.maxDotCount)
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);
        if (this.props.colors !== prevProps.colors)
            configDiff = Math.max(configDiff, ConfigDifference.RENDER);

        if (this.props.colors.length === 0)
            throw new Error("ScatterPlotBase: 'colors' prop must contain at least one element. You may omit it completely for default value.");

        // test if time interval changed
        const considerTs =  this.props.config.signalSets.some(setConf => !!setConf.tsSigCid);
        if (considerTs)
            configDiff = Math.max(configDiff, TimeIntervalDifference(this, prevProps));

        // test if limits changed
        if (!Object.is(prevProps.xMinValue, this.props.xMinValue) || !Object.is(prevProps.xMaxValue, this.props.xMaxValue) || !Object.is(prevProps.yMinValue, this.props.yMinValue) || !Object.is(prevProps.yMaxValue, this.props.yMaxValue))
            configDiff = Math.max(configDiff, ConfigDifference.DATA_WITH_CLEAR);

        if (configDiff === ConfigDifference.DATA_WITH_CLEAR)
        {
            this.resetZoom(false, false);
            this.setState({
                xMin: this.props.xMinValue,
                xMax: this.props.xMaxValue,
                yMin: this.props.yMinValue,
                yMax: this.props.yMaxValue,
                statusMsg: "Loading..."
            }, () => this.fetchData());
        }
        else if (configDiff === ConfigDifference.DATA) {
            // noinspection JSIgnoredPromiseFromCall
            this.fetchData();
        }
        else {
            const forceRefresh = this.prevContainerNode !== this.containerNode
                || prevState.signalSetsData !== this.state.signalSetsData
                || prevState.globalSignalSetsData !== this.state.globalSignalSetsData
                || prevState.brushInProgress !== this.state.brushInProgress
                || prevState.zoomYScaleMultiplier !== this.state.zoomYScaleMultiplier // update zoom extent
                || configDiff !== ConfigDifference.NONE;

            const updateZoom = !AreZoomTransformsEqual(prevState.zoomTransform, this.state.zoomTransform);

            this.createChart(forceRefresh, updateZoom);
            this.prevContainerNode = this.containerNode;
            if (updateZoom)
                this.callViewChangeCallback();
        }
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.resizeListener);
        window.removeEventListener('keydown', ::this.keydownListener);
        window.removeEventListener('keyup', ::this.keyupListener);
    }
    //</editor-fold>

    /** Creates the queries for fetchData method.
     *
     * The limits are set only after brush, otherwise they should be taken from state in this method.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {undefined|number} xMin - left boundary of the visible region
     * @param {undefined|number} xMax - right boundary of the visible region
     * @param {undefined|number} yMin - bottom boundary of the visible region
     * @param {undefined|number} yMax - top boundary of the visible region
     *
     * @returns {[[query], boolean, [object]]} tuple of three values:
     *
     *  - array of queries,
     *  - updateGlobals - true if extents should be updated by results of these queries,
     *  - additionalInformation - arbitrary, will be passed as argument to 'prepareData' method; this implementation: indices of signalSet configs for aggs queries */
    static getQueries(self, xMin, xMax, yMin, yMax) {
        const config = self.props.config;
        const queries = [];
        let isZoomedIn = !isNaN(xMin) || !isNaN(xMax) || !isNaN(yMin) || !isNaN(yMax);
        const additionalInformation = [];

        // update limits with current zoom - check if zoomTransform is almost equal to identity
        if (Math.abs(self.state.zoomTransform.k - 1) > 0.01 ||
            Math.abs(self.state.zoomYScaleMultiplier - 1) > 0.01 ||
            Math.abs(self.state.zoomTransform.x) > 3 ||
            Math.abs(self.state.zoomTransform.y) > 3) {

            isZoomedIn = true;

            // update limits with current zoom (if not set yet)
            if (xMin === undefined && !isNaN(self.state.xMin))
                xMin = self.state.xMin;
            if (xMax === undefined && !isNaN(self.state.xMax))
                xMax = self.state.xMax;
            if (yMin === undefined && !isNaN(self.state.yMin))
                yMin = self.state.yMin;
            if (yMax === undefined && !isNaN(self.state.yMax))
                yMax = self.state.yMax;
        }

        // set limits to props (if not set yet)
        if (xMin === undefined && !isNaN(self.props.xMinValue))
            xMin = self.props.xMinValue;
        if (xMax === undefined && !isNaN(self.props.xMaxValue))
            xMax = self.props.xMaxValue;
        if (yMin === undefined && !isNaN(self.props.yMinValue))
            yMin = self.props.yMinValue;
        if (yMax === undefined && !isNaN(self.props.yMaxValue))
            yMax = self.props.yMaxValue;

        const updateGlobals = !isZoomedIn;

        for (const [i, signalSet] of config.signalSets.entries()) {
            const getQueriesForSignalSet = self.props.getQueriesForSignalSet || ScatterPlotBase.getQueriesForSignalSet;
            const [qrys, additional] = getQueriesForSignalSet(self, signalSet, xMin, xMax, yMin, yMax, updateGlobals, i);
            queries.push(...qrys);
            additionalInformation.push(additional);
        }

        return [ queries, updateGlobals, additionalInformation ];
    }

    /** Creates the queries for one signalSet.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {object} signalSetConfig - configuration of the signalSet
     * @param {number} xMin - left boundary of the visible region
     * @param {number} xMax - right boundary of the visible region
     * @param {number} yMin - bottom boundary of the visible region
     * @param {number} yMax - top boundary of the visible region
     * @param {boolean} updateGlobals - If 'updateGlobals' is false, only 'docs' query is returned. If it is true, additional queries to get extent of data are also returned.
     * @param {int} signalSetIndex
     *
     * @returns {[query[], object]} tuple of two values:
     *
     *  - array of queries,
     *  - additionalInformation - arbitrary; this implementation: index of signalSet config for agg query */
    static getQueriesForSignalSet(self, signalSetConfig, xMin, xMax, yMin, yMax, updateGlobals = false, signalSetIndex = 0) {
        const qrys = [];
        let additional = undefined;
        let filter = {
            type: 'and',
            children: [
                {
                    type: "function_score",
                    function: {
                        "random_score": {}
                    }
                }
            ]
        };

        if (signalSetConfig.tsSigCid) {
            const abs = self.getIntervalAbsolute();
            filter.children.push({
                type: 'range',
                sigCid: signalSetConfig.tsSigCid,
                gte: abs.from.toISOString(),
                lt: abs.to.toISOString()
            });
        }

        // add x and y filters
        if (!isNaN(xMin))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.x_sigCid,
                gte: xMin
            });
        if (!isNaN(xMax))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.x_sigCid,
                lte: xMax
            });
        if (!isNaN(yMin))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.y_sigCid,
                gte: yMin
            });
        if (!isNaN(yMax))
            filter.children.push({
                type: "range",
                sigCid: signalSetConfig.y_sigCid,
                lte: yMax
            });
        // custom filter
        if (signalSetConfig.filter)
            filter.children.push(signalSetConfig.filter);
        if (self.props.filter)
            if (typeof(self.props.filter) === "function")
                filter.children.push(self.props.filter(signalSetConfig));
            else
                filter.children.push(self.props.filter);

        let limit = undefined;
        if (self.state.maxDotCount >= 0) {
            limit = self.state.maxDotCount;
        }

        // set signals
        let signals = [signalSetConfig.x_sigCid, signalSetConfig.y_sigCid];
        if (signalSetConfig.dotSize_sigCid)
            signals.push(signalSetConfig.dotSize_sigCid);
        if (signalSetConfig.colorContinuous_sigCid)
            signals.push(signalSetConfig.colorContinuous_sigCid);
        if (signalSetConfig.colorDiscrete_sigCid)
            signals.push(signalSetConfig.colorDiscrete_sigCid);
        if (signalSetConfig.label_sigCid)
            signals.push(signalSetConfig.label_sigCid);

        // main docs query
        qrys.push({
            type: "docs",
            args: [ signalSetConfig.cid, signals, filter, undefined, limit ]
        });

        // additional queries to get the extent of data
        if (updateGlobals) {
            const summary = {
                signals: {}
            };
            summary.signals[signalSetConfig.x_sigCid] = ["min", "max"];
            summary.signals[signalSetConfig.y_sigCid] = ["min", "max"];
            if (signalSetConfig.dotSize_sigCid)
                summary.signals[signalSetConfig.dotSize_sigCid] = ["min", "max"];
            if (signalSetConfig.colorContinuous_sigCid)
                summary.signals[signalSetConfig.colorContinuous_sigCid] = ["min", "max"];
            qrys.push({
                type: "summary",
                args: [ signalSetConfig.cid, filter, summary ]
            });

            if (signalSetConfig.colorDiscrete_sigCid) {
                const aggs = [{
                    sigCid: signalSetConfig.colorDiscrete_sigCid,
                    agg_type: "terms"
                }];
                qrys.push({
                    type: "aggs",
                    args: [signalSetConfig.cid, filter, aggs]
                });
                additional = signalSetIndex;
            }
        }

        return [qrys, additional];
    }

    /** Fetches new data for the chart and processes the results (updates the chart accordingly) */
    @withAsyncErrorHandler
    async fetchData(xMin, xMax, yMin, yMax) {
        this.setState({statusMsg: this.props.t('Loading...')});
        try {
            const getQueries = this.props.getQueries || ScatterPlotBase.getQueries;
            const [queries, updateGlobals, additionalInformation] = getQueries(this, xMin, xMax, yMin, yMax);
            const results = await this.dataAccessSession.getLatestMixed(queries);

            if (results) { // Results is null if the results returned are not the latest ones
                const prepareData = this.props.prepareData || ScatterPlotBase.prepareData;
                const [newState, xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents] = prepareData(this, results, queries, updateGlobals, additionalInformation);

                if (updateGlobals) {
                    this.xExtent = xExtent;
                    this.yExtent = yExtent;
                    this.sExtent = sExtent;
                    this.cExtent = cExtent;
                    this.cExtents = cExtents;
                    this.dExtent = dExtent;
                    this.dExtents = dExtents;
                }

                this.setState(newState, () => {
                    if (updateGlobals)
                        // call callViewChangeCallback when data new data without range filter are loaded as the xExtent might got updated (even though this.state.zoomTransform is the same)
                        this.callViewChangeCallback();
                });

                if (updateGlobals && newState.noData === true) {
                    this.clearChart();
                    return;
                }

                if (updateGlobals) { // zoomed completely out
                    this.globalRegressions = await this.createRegressions(newState.signalSetsData);
                }
                this.regressions = await this.createRegressions(newState.signalSetsData);
                this.createChart(true);
            }
        } catch (err) {
            this.setState({statusMsg: this.props.t("Error loading data.")});
            throw err;
        }
    }

    /**
     * Processes the data returned by the queries and returns newState (with signalSetsData containing processed results) and extents of signals.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param results - results of the queries (the data from server)
     * @param queries - the queries generated by 'getQueries' method
     * @param updateGlobals - the updateGlobals returned by 'getQueries' method
     * @param additionalInformation - the additionalInformation returned by 'getQueries' method
     *
     * @returns {[object]} - tuple of 8 values:
     *
     *  - newState - will be passed to this.setState(); should contain 'signalSetsData' field
     *  - extents (7 values) as returned from 'computeExtents' method
     * */
    static prepareData(self, results, queries, updateGlobals, additionalInformation) {
        const docsResults = results.filter((_, i) => queries[i].type === "docs");
        const processDocs = self.props.processDocs || ScatterPlotBase.processDocs;
        const processedResults = processDocs(self, docsResults);

        let xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents;
        if (updateGlobals) { // zoomed completely out
            if (!processedResults.some(d => d.length > 0)) {
                return [{
                    signalSetsData: null,
                    globalSignalSetsData: null,
                    noData: true,
                    statusMsg: self.props.t("No data.")
                }, xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents]; // extents are intentionally undefined here
            }

            const computeExtents = self.props.computeExtents || ScatterPlotBase.computeExtents;
            [xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents] = computeExtents(self, processedResults, results, queries, additionalInformation);
        }

        const newState = {
            signalSetsData: processedResults,
            statusMsg: "",
            noData: false
        };
        if (updateGlobals)
            newState.globalSignalSetsData = processedResults;

        return [newState, xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents];
    }

    /** Computes the extents (min, max) of all the signals. Called inside 'prepareData'.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {[[{ x, y, s?, c?, d?, label? }]]} processedResults - data as returned from 'processDocs' method
     * @param results - results of the queries (the data from server)
     * @param queries - the queries generated by 'getQueries' method
     * @param additionalInformation - the additionalInformation returned by 'getQueries' method
     *
     * @returns {[[number|string]]} - tuple of 7 values:
     *
     *  - xExtent - [min of x axis signal, max of x axis signal]
     *  - yExtent - [min of y axis signal, max of y axis signal]
     *  - sExtent - [min of size signal, max of size signal]
     *  - cExtent - [min of continuous color signals for all signalSets, max of continuous color signals for all signalSets]
     *  - cExtents - array - [min, max] of continuous color signal for each signalSet
     *  - dExtent - array of all values of all discrete color signals
     *  - dExtents - array of arrays - array of all values of discrete color signal for each signalSet
     * */
    static computeExtents(self, processedResults, results, queries, additionalInformation) {
        let xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents;
        const SignalSetsConfigs = self.props.config.signalSets;

        const summaryResults = results.filter((_, i) => queries[i].type === "summary");

        //<editor-fold desc="Y extent">
        if (self.props.yAxisExtentFromSampledData)
            yExtent = getExtent(processedResults, d => d.y);
        else {
            const yMin = d3Array.min(summaryResults, (summary, i) => {
                return summary[SignalSetsConfigs[i].y_sigCid].min;
            });
            const yMax = d3Array.max(summaryResults, (summary, i) => {
                return summary[SignalSetsConfigs[i].y_sigCid].max;
            });
            yExtent = [yMin, yMax];
        }
        yExtent = extentWithMargin(yExtent, 0.05);
        if (!isNaN(self.props.yMinValue)) yExtent[0] = self.props.yMinValue;
        if (!isNaN(self.props.yMaxValue)) yExtent[1] = self.props.yMaxValue;
        //</editor-fold>

        //<editor-fold desc="X extent">
        if (self.props.xAxisExtentFromSampledData)
            xExtent = getExtent(processedResults, d => d.x);
        else {
            const xMin = d3Array.min(summaryResults, (summary, i) => {
                return summary[SignalSetsConfigs[i].x_sigCid].min;
            });
            const xMax = d3Array.max(summaryResults, (summary, i) => {
                return summary[SignalSetsConfigs[i].x_sigCid].max;
            });
            xExtent = [xMin, xMax];
        }
        xExtent = extentWithMargin(xExtent, 0.05);
        if (!isNaN(self.props.xMinValue)) xExtent[0] = self.props.xMinValue;
        if (!isNaN(self.props.xMaxValue)) xExtent[1] = self.props.xMaxValue;
        //</editor-fold>

        //<editor-fold desc="Size extent">
        const sMin = d3Array.min(summaryResults, (summary, i) => {
            if (SignalSetsConfigs[i].hasOwnProperty("dotSize_sigCid"))
                return summary[SignalSetsConfigs[i].dotSize_sigCid].min;
        });
        const sMax = d3Array.max(summaryResults, (summary, i) => {
            if (SignalSetsConfigs[i].hasOwnProperty("dotSize_sigCid"))
                return summary[SignalSetsConfigs[i].dotSize_sigCid].max;
        });
        sExtent = [sMin, sMax];
        if (self.props.hasOwnProperty("minDotRadiusValue")) sExtent[0] = self.props.minDotSizeValue;
        if (self.props.hasOwnProperty("maxDotRadiusValue")) sExtent[1] = self.props.maxDotSizeValue;
        //</editor-fold>

        //<editor-fold desc="Color (continuous) extent">
        cExtents = [];
        for (let i = 0; i < processedResults.length; i++) {
            if (SignalSetsConfigs[i].hasOwnProperty("colorContinuous_sigCid")) {
                const signal = summaryResults[i][SignalSetsConfigs[i].colorContinuous_sigCid];
                cExtents[i] = [signal.min, signal.max];
                if (self.props.hasOwnProperty("minColorValue")) cExtents[i][0] = self.props.minColorValue;
                if (self.props.hasOwnProperty("maxColorValue")) cExtents[i][1] = self.props.maxColorValue;
            }
        }
        cExtent = [ d3Array.min(cExtents, ex => ex[0]), d3Array.max(cExtents, ex => ex[1]) ];
        //</editor-fold>

        //<editor-fold desc="Color (discrete) extent">
        dExtents = [];
        const aggsQueriesSignalSetIndices = additionalInformation;
        const aggResults = results.filter((_, i) => queries[i].type === "aggs");
        for (const [j, res] of aggResults.entries()) {
            const buckets = res[0].buckets;
            const i = aggsQueriesSignalSetIndices[j];
            const signalSetConfig = SignalSetsConfigs[i];
            if (self.props.colorValues && self.props.colorValues.length)
                dExtents[i] = self.props.colorValues;
            else
                dExtents[i] = buckets.map(b => b.key);

            if (Array.isArray(signalSetConfig.color) && signalSetConfig.color.length > 0)
                if (dExtents[i].length > signalSetConfig.color.length)
                    self.setFlashMessage("warning", "More values than colors in signal set config at index " + i + ". Colors will be repeated.");
        }
        dExtent = [...new Set(dExtents.flat())]; // get all keys in extents and then keeps only unique values
        if (self.props.config.signalSets.some(s => !Array.isArray(s.color)) && dExtent.length > self.props.colors.length)
            self.setFlashMessage("warning", "More values than colors in props. Colors will be repeated.");
        //</editor-fold>

        return [xExtent, yExtent, sExtent, cExtent, cExtents, dExtent, dExtents];
    }

    /** Creates (or updates) the chart with current data.
     * This method is called from componentDidUpdate automatically when state or config is updated.
     * All the 'createChart*' methods are called from here. */
    createChart(forceRefresh, updateZoom) {
        /** @description last data loaded by fetchData */
        const signalSetsData = this.state.signalSetsData;
        /** @description data loaded when chart was completely zoomed out */
        const globalSignalSetsData = this.state.globalSignalSetsData;

        const width = this.containerNode.getClientRects()[0].width;
        if (this.state.width !== width) {
            this.setState({
                width
            });
        }
        const widthChanged = width !== this.renderedWidth;
        if (!forceRefresh && !widthChanged && !updateZoom) {
            return;
        }
        this.renderedWidth = width;

        if (!signalSetsData || !globalSignalSetsData) {
            return;
        }

        this.updateLabels();

        const ySize = this.props.height - this.props.margin.top - this.props.margin.bottom;
        const xSize = width - this.props.margin.left - this.props.margin.right;
        const SignalSetsConfigs = this.props.config.signalSets;

        //<editor-fold desc="X and Y Scales">
        // y Scale
        const yScale = this.state.zoomTransform.scale(this.state.zoomYScaleMultiplier).rescaleY(d3Scale.scaleLinear()
            .domain(this.yExtent)
            .range([ySize, 0]));
        this.yScale = yScale;
        const yAxis = d3Axis.axisLeft(yScale);
        if (this.props.yAxisTicksCount) yAxis.ticks(this.props.yAxisTicksCount);
        if (this.props.yAxisTicksFormat) yAxis.tickFormat(this.props.yAxisTicksFormat);
        this.yAxisSelection.call(yAxis);
        this.yAxisLabelSelection.text(this.props.yAxisLabel).style("text-anchor", "middle");

        // x Scale
        const xScale = this.state.zoomTransform.rescaleX(d3Scale.scaleLinear()
            .domain(this.xExtent)
            .range([0, xSize]));
        this.xScale = xScale;
        const xAxis = d3Axis.axisBottom(xScale);
        if (this.props.xAxisTicksCount) xAxis.ticks(this.props.xAxisTicksCount);
        if (this.props.xAxisTicksFormat) xAxis.tickFormat(this.props.xAxisTicksFormat);
        this.xAxisSelection.call(xAxis);
        this.xAxisLabelSelection.text(this.props.xAxisLabel).style("text-anchor", "middle");
        //</editor-fold>

        // data filtering
        const filterData = this.props.filterData || ScatterPlotBase.filterData;
        const filteredData = filterData(this, signalSetsData, xScale.domain(), yScale.domain(), false);
        const filteredGlobalData = filterData(this, globalSignalSetsData, xScale.domain(), yScale.domain(), true);

        //<editor-fold desc="Size and Color Scales">
        // s Scale (dot size)
        let sScale = undefined;
        if (SignalSetsConfigs.some((cfg) => cfg.hasOwnProperty("dotSize_sigCid"))) {
            let sExtent = this.sExtent;
            if (this.props.updateSizeOnZoom) {
                const allFilteredData = filteredData.concat(filteredGlobalData);
                if (allFilteredData.length > 1) {
                    sExtent = this.getSExtent_notFlat(allFilteredData);
                }
            }

            sScale = d3Scale.scaleSqrt()
                .domain(sExtent)
                .range([this.props.minDotSize, this.props.maxDotSize]);
        }
        this.sScale = sScale;

        // c Scales (color) - separate for each signalSet
        let cScales = [];
        let cExtents = this.cExtents, cExtent = this.cExtent;
        if (this.props.updateColorOnZoom && SignalSetsConfigs.some(cfg => cfg.hasOwnProperty("colorContinuous_sigCid"))) {
            // recompute extents on filtered data
            for (let i = 0; i < filteredData.length; i++) {
                if (SignalSetsConfigs[i].hasOwnProperty("colorContinuous_sigCid")) {
                    const allFilteredData = filteredData[i].concat(filteredGlobalData[i]);
                    if (allFilteredData.length > 1)
                        cExtents[i] = this.getCExtent(allFilteredData);
                }
            }
            cExtent = [d3Array.min(cExtents, ex => ex[0]), d3Array.max(cExtents, ex => ex[1])];
        }
        for (let i = 0; i < filteredData.length; i++) {
            const signalSetConfig = SignalSetsConfigs[i];
            if (signalSetConfig.hasOwnProperty("colorContinuous_sigCid")) {
                if (Array.isArray(signalSetConfig.color) && signalSetConfig.color.length > 0)
                    cScales.push(getColorScale(cExtents[i], signalSetConfig.color));
                else
                    cScales.push(getColorScale(cExtent, this.props.colors));
            } else if (signalSetConfig.hasOwnProperty("colorDiscrete_sigCid")) {
                if (Array.isArray(signalSetConfig.color) && signalSetConfig.color.length > 0) {
                    const dExtent = this.dExtents[i];
                    cScales.push(d3Scale.scaleOrdinal(dExtent, signalSetConfig.color));
                } else {
                    cScales.push(d3Scale.scaleOrdinal(this.dExtent, this.props.colors));
                }
            } else {
                let color = this.getColor(i);
                cScales.push(_ => color);
            }
        }
        this.cScales = cScales;
        //</editor-fold>

        // draw data
        const drawChart = this.props.drawChart || ScatterPlotBase.drawChart;
        drawChart(this, filteredData, filteredGlobalData, xScale, yScale, sScale, cScales);
        this.drawRegressions(xScale, yScale, cScales);

        this.createChartCursor(xScale, yScale, sScale, cScales, filteredData);

        // we don't want to change brush and zoom when updating only zoom (it breaks touch drag)
        if (forceRefresh || widthChanged) {
            this.createChartBrush();
            if (this.props.withZoom)
                this.createChartZoom(xSize, ySize);
        }
    }

    /** Resets chart's zoom, brush, etc.
     * Should only be called when setting state to noData or similar situation, i.e. no data are rendered */
    clearChart() {
        this.brushParentSelection
            .on('mouseenter', null)
            .on('mousemove', null)
            .on('mouseleave', null);

        this.zoom = null;
        this.globalRegressions = [];
        this.regressions = [];
    }

    //<editor-fold desc="Data processing">
    /** Processes the records returned from server.
     *
     * The default implementation only renames the data from all signalSets to be in format [{ x, y, s?, c?, d?, label? }] ('?' marks optional property).
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param signalSetsData - results of the queries (the data from server)
     *
     * @returns {[[{ x, y, s?, c?, d?, label? }]]} - the processed data - an array for each signalSet
     * */
    static processDocs(self, signalSetsData) {
        const config = self.props.config;
        let ret = [];

        for (let i = 0; i < config.signalSets.length; i++) {
            const signalSetConfig = config.signalSets[i];
            let data = [];
            for (const d of signalSetsData[i]) {
                let d1 = {
                    x: d[signalSetConfig.x_sigCid],
                    y: d[signalSetConfig.y_sigCid]
                };
                if (signalSetConfig.dotSize_sigCid)
                    d1.s = d[signalSetConfig.dotSize_sigCid];
                if (signalSetConfig.colorContinuous_sigCid)
                    d1.c = d[signalSetConfig.colorContinuous_sigCid];
                if (signalSetConfig.colorDiscrete_sigCid)
                    d1.d = d[signalSetConfig.colorDiscrete_sigCid];
                if (signalSetConfig.label_sigCid)
                    d1.label = d[signalSetConfig.label_sigCid];
                data.push(d1);
            }
            ret.push(data);
        }
        return ret;
    }

    getCExtent(data) {
        let extent = d3Array.extent(data, d => d.c);
        return this.updateCExtent(extent);
    }

    updateCExtent(extent) {
        if (this.props.hasOwnProperty("minColorValue"))
            extent[0] = this.props.minColorValue;
        if (this.props.hasOwnProperty("maxColorValue"))
            extent[1] = this.props.maxColorValue;
        return extent;
    }

    getSExtent_notFlat(data) {
        let extent = getExtent(data, d => d.s);
        return this.updateSExtent(extent);
    }

    updateSExtent(extent) {
        if (this.props.hasOwnProperty("minDotRadiusValue"))
            extent[0] = this.props.minDotSizeValue;
        if (this.props.hasOwnProperty("maxDotRadiusValue"))
            extent[1] = this.props.maxDotSizeValue;
        return extent;
    }

    updateLabels() {
        this.labels = {};
        for (let i = 0; i < this.props.config.signalSets.length; i++) {
            const signalSetConfig = this.props.config.signalSets[i];
            this.labels[signalSetConfig.cid + "-" + i] = signalSetConfig.tooltipLabels || {};
            if (signalSetConfig.label !== undefined)
                this.labels[signalSetConfig.cid + "-" + i].label = signalSetConfig.label;
        }
    }

    /**
     * Filters data to show only the visible ones (inside the rendered rectangle).
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {[[{ x, y, s?, c?, d?, label? }]]} setsData - data for all signal sets in format as produces by 'processDocs'
     * @param {[number, number]} xExtent - extent of vertical axis: [xMin, xMax]
     * @param {[number, number]} yExtent - extent of horizontal axis: [yMin, yMax]
     * @param {boolean} global - true if filtering global dots
     *
     * @return {[[{ x, y, s?, c?, d?, label? }]]} - filtered data in the same format
     */
    static filterData(self, setsData, xExtent, yExtent, global) {
        return setsData.map((data, i) => {
            if (!isSignalVisible(self.props.config.signalSets[i]))
                return [];
            return data.filter(d => isInExtent(d.x, xExtent) && isInExtent(d.y, yExtent))
        });
    }
    //</editor-fold>

    //<editor-fold desc="Data drawing">
    /** Gets color for signalSet
     * @param index     signalSet index in this.props.config */
    getColor(index) {
        let color = this.props.config.signalSets[index].color || this.props.colors[index] || "black";
        if (Array.isArray(color))
            return d3Color.color(color[0]);
        else
            return d3Color.color(color);
    }

    /**
     * Draws the dots for all signal sets. Calls 'drawDots' method inside.
     *
     * self.chartSelection is the SVG node to which the chart should be rendered (self.dotsSelection, etc. are children of this node). See the render method of ScatterPlotBase for more details.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {[[{ x, y, s?, c?, d?, label? }]]} filteredData - data in format as produces by 'filterData' ('processData')
     * @param {[[{ x, y, s?, c?, d?, label? }]]} filteredGlobalData - global data in format as produces by 'filterData' ('processData')
     * @param xScale - scale which converts x values to pixels along horizontal axis
     * @param yScale - scale which converts y values to pixels along vertical axis
     * @param sScale - scale which converts size values to radius of dot in pixels
     * @param cScales - array of scales which convert c or d values to color (one for each signal set)
     */
    static drawChart(self, filteredData, filteredGlobalData, xScale, yScale, sScale, cScales) {
        const SignalSetsConfigs = self.props.config.signalSets;

        for (let i = 0; i < filteredData.length; i++) {
            const cidIndex = SignalSetsConfigs[i].cid + "-" + i;

            const drawDots = self.props.drawDots || ScatterPlotBase.drawDots;
            drawDots(self, filteredData[i], self.dotsSelection[cidIndex], xScale, yScale, sScale, cScales[i], SignalSetsConfigs[i], SignalSetsConfigs[i].dotShape || ScatterPlotBase.defaultDotShape);
            drawDots(self, filteredGlobalData[i], self.dotsGlobalSelection[cidIndex], xScale, yScale, sScale, cScales[i], SignalSetsConfigs[i], SignalSetsConfigs[i].globalDotShape || ScatterPlotBase.defaultGlobalDotShape, SignalSetsConfigs[i].getGlobalDotColor || ScatterPlotBase.defaultGetGlobalDotColor);
        }
    }

    /**
     * Draws the dots for one signal sets.
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {[{ x, y, s?, c?, d?, label? }]} data - data for one signal set
     * @param selection - d3 selection to which the data will be assigned and drawn
     * @param xScale - scale which converts x values to pixels along horizontal axis
     * @param yScale - scale which converts y values to pixels along vertical axis
     * @param sScale - scale which converts size values to radius of dot in pixels
     * @param cScale - scale which convert c or d values to color
     * @param {object} signalSetConfig - configuration of the signalSet
     * @param {string} dotShape - SVG id (excl. '#')
     * @param {function} modifyColor - function to modify dot color after getting it from cScale (used for global dots and highlight dots)
     */
    static drawDots(self, data, selection, xScale, yScale, sScale, cScale, signalSetConfig, dotShape, modifyColor) {
        const size = (signalSetConfig.dotSize ? signalSetConfig.dotSize : self.props.dotSize);
        const constantSize = !signalSetConfig.hasOwnProperty("dotSize_sigCid");
        const s = constantSize ? _ => size : d => sScale(d.s);
        if (modifyColor === undefined)
            modifyColor = c => c;

        if (dotShape === "none") {
            selection.selectAll('use').remove();
            return;
        }
        dotShape = "#" + dotShape;

        // create dots on chart
        const keyFunc = d => (signalSetConfig.label_sigCid ? d => d.label + " " : "") + d.x + " " + d.y;
        const dots = selection
            .selectAll('use')
            .data(data, keyFunc);

        // enter
        const allDots = dots.enter()
            .append('use')
            .attr('href', dotShape)
            .attr('transform', d => `scale(${s(d)})`)
            .merge(dots)
            .attr('x', d => xScale(d.x))
            .attr('y', d => yScale(d.y))
            .style("transform-origin", d => `${xScale(d.x)}px ${yScale(d.y)}px`);

        // update
        (self.props.withTransition ? allDots.transition() : allDots)
            .attr('transform', d => `scale(${s(d)})`)
            .attr('fill', d => modifyColor(d3Color.color(cScale(d.c || d.d))))
            .attr('stroke', d => modifyColor(d3Color.color(cScale(d.c || d.d))));

        // remove
        dots.exit()
            .remove();
    }

    /**
     * Draws the highlight dot (the dot closest to the cursor) for one signal sets. If the record is null, no highlight dot should be drawn (all existing highlight dots should be removed).
     *
     * @param {ScatterPlotBase} self - this ScatterPlotBase object
     * @param {{ x, y, s?, c?, d?, label? } | null} record - the data point for highlight dot
     * @param selection - d3 selection to which the data will be assigned and drawn
     * @param xScale - scale which converts x values to pixels along horizontal axis
     * @param yScale - scale which converts y values to pixels along vertical axis
     * @param sScale - scale which converts size values to radius of dot in pixels
     * @param cScale - scale which convert c or d values to color
     * @param {object} signalSetConfig - configuration of the signalSet
     * @param {string} dotShape - SVG id (excl. '#')
     */
    static drawHighlightDot(self, record, selection, xScale, yScale, sScale, cScale, signalSetConfig, dotShape) {
        const drawDots = self.props.drawDots || ScatterPlotBase.drawDots;
        drawDots(self, record !== null ? [record] : [], selection, xScale, yScale, sScale, cScale, signalSetConfig, signalSetConfig.dotShape || ScatterPlotBase.defaultDotShape, c => c.darker());
    }
    //</editor-fold>

    //<editor-fold desc="Regressions">
    async createRegressions(SignalSetsData) {
        let ret = [];
        for (let i = 0; i < SignalSetsData.length; i++) {
            const data = SignalSetsData[i];
            const signalSetConfig = this.props.config.signalSets[i];

            if (signalSetConfig.hasOwnProperty("regressions")) {
                for (const regConfig of signalSetConfig.regressions) {
                    if (regConfig.hasOwnProperty("createRegressionForEachColor") && regConfig.createRegressionForEachColor && signalSetConfig.hasOwnProperty("colorDiscrete_sigCid")) {
                        for (const category of this.dExtents[i]) {
                            const reg = this.createRegression(data.filter(d => d.d === category), this.xExtent, regConfig, signalSetConfig);
                            if (reg === undefined)
                                continue;

                            reg.filter = category;
                            reg.label += ": " + category;
                            reg.signalSetIndex = i;
                            ret.push(reg);
                        }
                    } else {
                        const reg = this.createRegression(data, this.xExtent, regConfig, signalSetConfig);
                        if (reg === undefined)
                            continue;

                        reg.signalSetIndex = i;
                        ret.push(reg);
                    }
                }
            }
        }
        return ret;
    }

    createRegression(data, domain, regressionConfig, signalSetConfig) {
        let regression;
        switch (regressionConfig.type) {
            case "linear":
                regression = d3Regression.regressionLinear();
                break;
            case "exponential":
                regression = d3Regression.regressionExp();
                break;
            case "logarithmic":
                regression = d3Regression.regressionLog();
                break;
            case "quadratic":
                regression = d3Regression.regressionQuad();
                break;
            case "polynomial":
                regression = d3Regression.regressionPoly();
                if (regressionConfig.order)
                    regression.order(regressionConfig.order);
                break;
            case "power":
                regression = d3Regression.regressionPow();
                break;
            case "loess":
                regression = d3Regression.regressionLoess();
                if (regressionConfig.bandwidth)
                    regression.bandwidth(regressionConfig.bandwidth);
                break;
            default:
                console.error("Regression type not supported: ", regressionConfig.type);
                return undefined;
        }

        regression.x(d => d.x)
                  .y(d => d.y);
        if (typeof regression.domain === "function")
            regression.domain(domain);

        return {
            data: regression(data),
            label: signalSetConfig.label ? signalSetConfig.label : signalSetConfig.cid,
            config: regressionConfig
        };
    }

    getRegressionColor(regression, cScales) {
        if (Array.isArray(regression.config.color) && regression.config.color.length > 0) {
            if (regression.filter) {
                const i = this.dExtents[regression.signalSetIndex].indexOf(regression.filter) % regression.config.color.length;
                return d3Color.color(regression.config.color[i]);
            }
            else
                return d3Color.color(regression.config.color[0]);
        }
        else if (regression.config.color)
            return d3Color.color(regression.config.color);
        else {
            if (regression.filter)
                return cScales[regression.signalSetIndex](regression.filter);
            else
                return this.getColor(regression.signalSetIndex);
        }
    }

    drawRegressions(xScale, yScale, cScales) {
        for (let i = 0; i < this.globalRegressions.length; i++) {
            this.globalRegressions[i].color = ModifyColorCopy(this.getRegressionColor( this.globalRegressions[i], cScales), 0.3);
        }
        for (let i = 0; i < this.regressions.length; i++) {
            this.regressions[i].color = this.getRegressionColor(this.regressions[i], cScales);
        }

        // noinspection JSUnresolvedVariable
        const regressions = this.regressionsSelection
            .selectAll("path")
            .data(d3Array.merge([this.globalRegressions, this.regressions])
                .filter(reg => isSignalVisible(this.props.config.signalSets[reg.signalSetIndex])));

        const lineGenerator = d3Shape.line()
            .x(d => xScale(d[0]))
            .y(d => yScale(d[1]))
            .curve(d3Shape.curveBasis);

        regressions.enter()
            .append('path')
            .attr('stroke-width', "2px")
            .attr('fill', 'none')
            .merge(regressions)
            .attr('stroke', d => d.color)
            .attr('d', d => lineGenerator(d.data));

        regressions.exit()
            .remove();

        this.drawRegressionCoefficients();
    }

    drawRegressionCoefficients() {
        if (!this.props.withRegressionCoefficients)
            return;

        this.regressionsCoefficients.selectAll("*").remove();

        if (this.regressions.length <= 0)
            return;

        this.regressionsCoefficients.append("h4").text("Regression coefficients");

        const coeffs = this.regressionsCoefficients
            .selectAll("div")
            .data(this.regressions);

        const drawCoefficients = function (r) {
            const data = r.data;
            switch (r.config.type) {
                case "linear":
                    return `<b>${r.label} (${r.config.type})</b>: <i>slope:</i> ${d3Format.format(".3r")(data.a)}; <i>intercept:</i> ${d3Format.format(".3r")(data.b)}`;
                case "exponential":
                case "logarithmic":
                case "power":
                    return `<b>${r.label} (${r.config.type})</b>: <i>a:</i> ${d3Format.format(".3r")(data.a)}; <i>b:</i> ${d3Format.format(".3r")(data.b)}`;
                case "quadratic":
                    return `<b>${r.label} (${r.config.type})</b>: <i>a:</i> ${d3Format.format(".3r")(data.a)}; <i>b:</i> ${d3Format.format(".3r")(data.b)}; <i>c:</i> ${d3Format.format(".3r")(data.c)}`;
                case "polynomial":
                    return `<b>${r.label} (${r.config.type})</b>: <i>coefficients (highest degree last):</i> ${data.coefficients.map(c => d3Format.format(".3r")(c)).join(",&ensp;")}`;
                case "loess":
                    return;
            }
        };

        coeffs.enter().append("div")
            .merge(coeffs)
            .html(drawCoefficients);
    }
    //</editor-fold>

    //<editor-fold desc="Cursor and Brush">
    /** Handles mouse movement to select the closest dot (for displaying its details in Tooltip, etc.).
     *  Called from this.createChart(). */
    createChartCursor(xScale, yScale, sScale, cScales, signalSetsData) {
        const self = this;

        let selections = this.state.selections;
        let mousePosition;

        const selectPoints = function () {
            const containerPos = d3Selection.mouse(self.containerNode);
            const x = containerPos[0] - self.props.margin.left;
            const y = containerPos[1] - self.props.margin.top;

            let newSelections = {};

            for (let i = 0; i < signalSetsData.length && i < self.props.config.signalSets.length; i++) {
                const signalSetCidIndex = self.props.config.signalSets[i].cid + "-" + i;

                const data = signalSetsData[i];
                let newSelection = null;
                let minDist = Number.MAX_VALUE;
                for (const point of data) {
                    const dist = distance({x, y}, {x: xScale(point.x), y: yScale(point.y)});
                    if (dist < minDist) {
                        minDist = dist;
                        newSelection = point;
                    }
                }

                const signalSetConfig = self.props.config.signalSets[i];
                const drawHighlightDot = self.props.drawHighlightDot || ScatterPlotBase.drawHighlightDot;
                drawHighlightDot(self, newSelection, self.dotHighlightSelections[signalSetCidIndex], xScale, yScale, sScale, cScales[i], signalSetConfig, signalSetConfig.dotShape || ScatterPlotBase.defaultDotShape);

                newSelections[signalSetCidIndex] = newSelection;
            }

            self.cursorSelectionX
                .attr('y1', self.props.margin.top)
                .attr('y2', self.props.height - self.props.margin.bottom)
                .attr('x1', containerPos[0])
                .attr('x2', containerPos[0])
                .attr('visibility', self.props.withCursor ? "visible" : "hidden");

            self.cursorSelectionY
                .attr('y1', containerPos[1])
                .attr('y2', containerPos[1])
                .attr('x1', self.props.margin.left)
                .attr('x2', self.renderedWidth - self.props.margin.right)
                .attr('visibility', self.props.withCursor ? "visible" : "hidden");

            let allNull = true;
            for (const selName in newSelections)
                if (newSelections[selName] !== null)
                    allNull = false;
            if (allNull)
                newSelections = null;

            selections = newSelections;
            mousePosition = {x: containerPos[0], y: containerPos[1]};

            self.setState({
                selections,
                mousePosition
            });
        };

        this.brushParentSelection
            .on('mouseenter', selectPoints)
            .on('mousemove', selectPoints)
            .on('mouseleave', ::this.deselectPoints);
    }

    deselectPoints() {
        this.cursorSelectionX.attr('visibility', 'hidden');
        this.cursorSelectionY.attr('visibility', 'hidden');

        for (let i = 0; i < this.props.config.signalSets.length; i++) {
            const signalSetCidIndex = this.props.config.signalSets[i].cid + "-" + i;
            const signalSetConfig = this.props.config.signalSets[i];

            const drawHighlightDot = this.props.drawHighlightDot || ScatterPlotBase.drawHighlightDot;
            drawHighlightDot(this, null, this.dotHighlightSelections[signalSetCidIndex], this.xScale, this.yScale, this.sScale, this.cScales[i], signalSetConfig, signalSetConfig.dotShape || ScatterPlotBase.defaultDotShape);
        }

        this.setState({
            selections: null,
            mousePosition: null
        });
    }

    /** Prepares the d3 brush for region selection.
     *  Called from this.createChart(). */
    createChartBrush() {
        const self = this;

        if (this.props.withBrush && this.state.brushInProgress) {
            const xSize = this.renderedWidth - this.props.margin.left - this.props.margin.right;
            const ySize = this.props.height - this.props.margin.top - this.props.margin.bottom;
            const brush = d3Brush.brush()
                .extent([[0, 0], [xSize, ySize]])
                .filter(() => {
                    // noinspection JSUnresolvedVariable
                    return !d3Event.button // enable brush when ctrl is pressed, modified version of default brush filter (https://github.com/d3/d3-brush#brush_filter)
                })
                .on("start", function () {
                    self.setState({
                        zoomInProgress: true
                    });
                })
                .on("end", function () {
                    if (self.props.withZoom)
                        self.setState({
                            zoomInProgress: false
                        });
                    // noinspection JSUnresolvedVariable
                    const sel = d3Event.selection;

                    if (sel) {
                        const xMin = self.xScale.invert(sel[0][0]);
                        const xMax = self.xScale.invert(sel[1][0]);
                        const yMin = self.yScale.invert(sel[1][1]);
                        const yMax = self.yScale.invert(sel[0][1]);
                        self.lastZoomCausedByUser = true;
                        self.setZoomToLimits(xMin, xMax, yMin, yMax);

                        if (self.props.withAutoRefreshOnBrush) {
                            // load new data for brushed region
                            self.reloadData(xMin, xMax, yMin, yMax);
                        }

                        // hide brush
                        self.brushSelection.call(brush.move, null);
                        self.deselectPoints();
                        self.setState({
                            brushInProgress: false
                        });
                    }
                });

            this.brushSelection
                .attr('pointer-events', 'all')
                .call(brush);
        }
        else {
            this.brushParentSelection
                .selectAll('rect')
                .remove();
            this.brushSelection
                .attr('pointer-events', 'none');

            this.brushParentSelection
                .insert('rect', "g") // insert it before the brushSelection
                .attr('pointer-events', 'all')
                .attr('cursor', 'crosshair')
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', this.renderedWidth - this.props.margin.left - this.props.margin.right)
                .attr('height', this.props.height - this.props.margin.top - this.props.margin.bottom)
                .attr('visibility', 'hidden');
        }
    }
    //</editor-fold>

    //<editor-fold desc="Zoom (current view)">
    /** Handles zoom of the chart by user using d3-zoom.
     *  Called from this.createChart(). */
    createChartZoom(xSize, ySize) {
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
                self.setState({
                    zoomTransform: d3Event.transform
                });
            }
        };

        const handleZoomEnd = function () {
            self.deselectPoints();
            self.setState({
                zoomInProgress: false
            });
            self.setLimitsToCurrentZoom();
        };

        const handleZoomStart = function () {
            self.setState({
                zoomInProgress: true
            });
        };

        const zoomExtent = [[0, 0], [xSize, ySize]];
        const translateExtent = [[0, 0], [xSize, ySize * this.state.zoomYScaleMultiplier]];
        const zoomExisted = this.zoom !== null;
        this.zoom = zoomExisted ? this.zoom : d3Zoom.zoom();
        this.zoom
            .scaleExtent([this.props.zoomLevelMin, this.props.zoomLevelMax])
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
            .wheelDelta(WheelDelta(3));
        this.svgContainerSelection.call(this.zoom);
        if (!zoomExisted)
            this.setLimitsToCurrentZoom(); // initialize limits
    }

    /**
     * Set the visible region of the chart to defined limits (in units of the data, not in pixels)
     * @param xMin              left boundary of the visible region (in units of data on x-axis)
     * @param xMax              right boundary of the visible region (in units of data on x-axis)
     * @param yMin              bottom boundary of the visible region (in units of data on y-axis)
     * @param yMax              top boundary of the visible region (in units of data on y-axis)
     * @param source            the element which caused the view change (if source === this, the update is ignored)
     * @param causedByUser      tells whether the view update was caused by user (this propagates to props.viewChangeCallback call), default = false
     * @param withTransition    set to true if view change should be animated (props.withTransition must be also true), default = false
     */
    setView(xMin, xMax, yMin, yMax, source, causedByUser = false, withTransition = false) {
        if (source === this || this.state.noData)
            return;

        if (xMin === undefined) xMin = this.xScale.domain()[0];
        if (xMax === undefined) xMax = this.xScale.domain()[1];
        if (yMin === undefined) yMin = this.yScale.domain()[0];
        if (yMax === undefined) yMax = this.yScale.domain()[1];

        if (isNaN(xMin) || isNaN(xMax) || isNaN(yMin) || isNaN(yMax))
            throw new Error("Parameters must be numbers.");

        this.lastZoomCausedByUser = causedByUser;
        this.setZoomToLimits(xMin, xMax, yMin, yMax, withTransition);
    }

    /** Returns the current view (boundaries of visible region)
     * @return {{xMin: number, xMax: number, yMin: number, yMax: number }} left, right, bottom, top boundary
     */
    getView() {
        if (this.state.noData)
            return undefined, undefined, undefined, undefined;
        const [xMin, xMax] = this.xScale.domain();
        const [yMin, yMax] = this.yScale.domain();
        return {xMin, xMax, yMin, yMax};
    }

    /** updates state with current limits */
    setLimitsToCurrentZoom() {
        this.setState(this.getView());
    }

    /** sets zoom object (transform) to desired view boundaries */
    setZoomToLimits(xMin, xMax, yMin, yMax, withTransition) {
        const newXSize = xMax - xMin;
        const newYSize = yMax - yMin;
        const oldXSize = this.xScale.domain()[1] - this.xScale.domain()[0];
        const oldYSize = this.yScale.domain()[1] - this.yScale.domain()[0];

        const oldZoomYScaleMultiplier = this.state.zoomYScaleMultiplier;
        const scaleFactor = (oldYSize * newXSize) / (oldXSize * newYSize);
        const newZoomYScaleMultiplier =  scaleFactor * oldZoomYScaleMultiplier;

        const selTopLeftInverted = this.state.zoomTransform.invert([this.xScale(xMin), this.yScale(yMax)]);
        const transform = d3Zoom.zoomIdentity.scale(this.state.zoomTransform.k * oldXSize / newXSize).translate(-selTopLeftInverted[0], -selTopLeftInverted[1] * scaleFactor);

        this.setZoom(transform, newZoomYScaleMultiplier, withTransition);
    }

    /** helper method to update zoom transform in state and zoom object */
    setZoom(transform, yScaleMultiplier, withTransition = true) {
        const self = this;
        if (this.props.withZoom && this.zoom) {
            if (this.props.withTransition && withTransition) {
                const transition = this.svgContainerSelection.transition().duration(500)
                    .tween("yZoom", () => function (t) {
                        self.setState({
                            zoomYScaleMultiplier: self.state.zoomYScaleMultiplier * (1 - t) + yScaleMultiplier * t
                        });
                    });
                transition.call(this.zoom.transform, transform);
            } else {
                this.svgContainerSelection.call(this.zoom.transform, transform);
                this.setState({
                    zoomYScaleMultiplier: yScaleMultiplier
                });
            }
        }
        else {
            if (this.props.withTransition && withTransition) {
                this.setState({zoomInProgress: true}, () => {
                    transitionInterpolate(this.svgContainerSelection, this.state.zoomTransform, transform,
                        setZoomTransform(this), () => {
                            self.setState({zoomInProgress: false});
                            self.deselectPoints();
                        }, 500, self.state.zoomYScaleMultiplier, yScaleMultiplier);
                });
            }
            else {
                this.setState({
                    zoomTransform: transform,
                    zoomYScaleMultiplier: yScaleMultiplier
                });
                this.deselectPoints();
            }
        }
    }

    callViewChangeCallback() {
        if (typeof(this.props.viewChangeCallback) !== "function")
            return;

        this.props.viewChangeCallback(this, this.getView(), this.lastZoomCausedByUser);
    }
    //</editor-fold>

    //<editor-fold desc="Toolbar">
    setSettings(maxDotCount, withTooltip) {
        this.setWithTooltip(withTooltip);
        this.setMaxDotCount(maxDotCount)
    }

    setWithTooltip(newValue) {
        if (typeof newValue !== "boolean")
            newValue = ScatterPlotBase.defaultProps.withTooltip;
        this.setState({
            withTooltip: newValue
        });
    }

    setMaxDotCount(newValue) {
        if (isNaN(newValue))
            newValue = ScatterPlotBase.defaultProps.maxDotCount;
        this.setState({
            maxDotCount: newValue
        });
    }

    zoomIn(causedByUser = true) {
        this.lastZoomCausedByUser = causedByUser;
        this.svgContainerSelection.transition().call(this.zoom.scaleBy, this.props.zoomLevelStepFactor);
    };

    zoomOut(causedByUser = true) {
        this.lastZoomCausedByUser = causedByUser;
        this.svgContainerSelection.transition().call(this.zoom.scaleBy, 1.0 / this.props.zoomLevelStepFactor);
    };

    resetZoom(causedByUser = true, withTransition = true) {
        this.lastZoomCausedByUser = causedByUser;
        this.setZoom(d3Zoom.zoomIdentity, 1, withTransition);
    }

    reloadData(xMin, xMax, yMin, yMax) {
        // noinspection JSIgnoredPromiseFromCall
        this.fetchData(xMin, xMax, yMin, yMax);
    }

    /** toggle between brush and zoom, returns true if brush is enabled after call */
    brushButtonClick() {
        const brushEnabled = !this.state.brushInProgress;
        this.setState({
            brushInProgress: brushEnabled
        });
        return brushEnabled;
    };
    //</editor-fold>

    render() {
        if (this.state.noData) {
            return (
                <svg ref={node => this.containerNode = node} height={this.props.height} width="100%"
                     className={this.props.className} style={this.props.style} >
                    <text textAnchor="middle" x="50%" y="50%"
                          fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                        {this.state.statusMsg}
                    </text>
                </svg>
            );
        }
        else {
            this.dotHighlightSelections = {};
            const dotsHighlightSelectionGroups = this.props.config.signalSets.map((signalSet, i) =>
                <g key={signalSet.cid + "-" + i}
                   ref={node => this.dotHighlightSelections[signalSet.cid + "-" + i] = select(node)}/>
            );

            this.dotsSelection = {};
            const dotsSelectionGroups = this.props.config.signalSets.map((signalSet, i) =>
                <g key={signalSet.cid + "-" + i}
                   ref={node => this.dotsSelection[signalSet.cid + "-" + i] = select(node)}/>
            );

            this.dotsGlobalSelection = {};
            const dotsGlobalSelectionGroups = this.props.config.signalSets.map((signalSet, i) =>
                <g key={signalSet.cid + "-" + i}
                   ref={node => this.dotsGlobalSelection[signalSet.cid + "-" + i] = select(node)}/>
            );

            return (
                <div className={this.props.className} style={this.props.style} >
                    {this.props.withToolbar &&
                    <ScatterPlotToolbar resetZoomClick={::this.resetZoom}
                                        zoomInClick={this.props.withZoom ? ::this.zoomIn : undefined}
                                        zoomOutClick={this.props.withZoom ? ::this.zoomOut : undefined}
                                        reloadDataClick={::this.reloadData}
                                        brushClick={this.props.withBrush ? ::this.brushButtonClick : undefined}
                                        brushInProgress={this.state.brushInProgress}

                                        withSettings={this.props.withSettings}
                                        settings={{
                                            xMin: this.state.xMin,
                                            xMax: this.state.xMax,
                                            yMin: this.state.yMin,
                                            yMax: this.state.yMax,
                                            withTooltip: this.state.withTooltip,
                                            maxDotCount: this.state.maxDotCount
                                        }}
                                        setLimits={::this.setView}
                                        setSettings={::this.setSettings}
                    />}

                    <div ref={node => this.svgContainerSelection = select(node)} className={`${styles.touchActionNone} ${styles.clearBoth}`}>
                        <svg id="cnt" ref={node => this.containerNode = node} height={this.props.height} width="100%">
                            <defs>
                                <clipPath id="plotRect">
                                    <rect x="0" y="0" width={this.state.width - this.props.margin.left - this.props.margin.right} height={this.props.height - this.props.margin.top - this.props.margin.bottom} />
                                </clipPath>
                                {/* dot shape definitions */}
                                {dotShapes}
                            </defs>
                            <g transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} clipPath="url(#plotRect)" ref={node => this.chartSelection = select(node)} >
                                <g name={"regressions"} ref={node => this.regressionsSelection = select(node)}/>
                                <g name={"dots_global"}>{dotsGlobalSelectionGroups}</g>
                                <g name={"dots"}>{dotsSelectionGroups}</g>
                                <g name={"highlightDots"} visibility={(this.props.withCursor || this.state.withTooltip) && !this.state.zoomInProgress ? "visible" : "hidden"} >{dotsHighlightSelectionGroups}</g>
                            </g>

                            {/* axes */}
                            <g ref={node => this.xAxisSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.height - this.props.margin.bottom})`}/>
                            <text ref={node => this.xAxisLabelSelection = select(node)}
                                  transform={`translate(${this.props.margin.left + (this.state.width - this.props.margin.left - this.props.margin.right) / 2}, ${this.props.height - 5})`} />
                            <g ref={node => this.yAxisSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`}/>
                            <text ref={node => this.yAxisLabelSelection = select(node)}
                                  transform={`translate(${15}, ${this.props.margin.top + (this.props.height - this.props.margin.top - this.props.margin.bottom) / 2}) rotate(-90)`} />

                            {/* cursor lines */}
                            {!this.state.zoomInProgress &&
                            <line ref={node => this.cursorSelectionX = select(node)} strokeWidth="1"
                                  stroke="rgb(50,50,50)"
                                  visibility="hidden"/> }
                            {!this.state.zoomInProgress &&
                            <line ref={node => this.cursorSelectionY = select(node)} strokeWidth="1"
                                  stroke="rgb(50,50,50)"
                                  visibility="hidden"/> }

                            {/* status message */}
                            <text textAnchor="middle" x="50%" y="50%"
                                  fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif" fontSize="14px">
                                {this.state.statusMsg}
                            </text>

                            {/* tooltip */}
                            {this.state.withTooltip && !this.state.zoomInProgress &&
                            <Tooltip
                                name={"Tooltip"}
                                config={this.props.config}
                                signalSetsData={{}}
                                containerHeight={this.props.height}
                                containerWidth={this.state.width}
                                mousePosition={this.state.mousePosition}
                                selection={this.state.selections}
                                width={250}
                                contentRender={props => <TooltipContent {...props} labels={this.labels}/>}
                            /> }

                            {/* brush */}
                            <g ref={node => this.brushParentSelection = select(node)}
                               transform={`translate(${this.props.margin.left}, ${this.props.margin.top})`} >
                                <g ref={node => this.brushSelection = select(node)} />
                            </g>
                        </svg>
                    </div>
                    {this.props.withRegressionCoefficients &&
                    <div ref={node => this.regressionsCoefficients = select(node)} className={styles.regressionsCoefficients}/>}
                </div>
            );
        }
    }
}