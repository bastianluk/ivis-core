'use strict';

import React, {Component} from "react";
import {withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {ScatterPlotBase} from "./ScatterPlotBase";
import {PropType_d3Color_Required} from "../lib/CustomPropTypes";
import {dotShapeNames} from "./dot_shapes";

@withComponentMixins([
    withTranslation,
    withErrorHandling
], ["setMaxDotCount", "setWithTooltip", "getView", "setView"], ["getQueries", "getQueriesForSignalSet", "prepareData", "computeExtents", "processDocs", "filterData", "drawChart", "drawDots", "drawHighlightDot"])
export class BubblePlot extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        config: PropTypes.shape({
            signalSets: PropTypes.arrayOf(PropTypes.shape({
                cid: PropTypes.string.isRequired,
                x_sigCid: PropTypes.string.isRequired,
                y_sigCid: PropTypes.string.isRequired,
                dotSize_sigCid: PropTypes.string.isRequired,
                colorContinuous_sigCid: PropTypes.string,
                colorDiscrete_sigCid: PropTypes.string,
                tsSigCid: PropTypes.string, // for use of TimeContext
                label_sigCid: PropTypes.string,
                color: PropTypes.oneOfType([PropType_d3Color_Required(), PropTypes.arrayOf(PropType_d3Color_Required())]),
                label: PropTypes.string,
                enabled: PropTypes.bool,
                dotShape: PropTypes.oneOf(dotShapeNames), // default = ScatterPlotBase.dotShape
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
        minDotSize: PropTypes.number,
        maxDotSize: PropTypes.number,
        highlightDotSize: PropTypes.number, // radius multiplier
        colors: PropTypes.arrayOf(PropType_d3Color_Required()), // if specified, uses same cScale for all signalSets that have color*_sigCid and config.signalSets[*].color is not array

        xMinValue: PropTypes.number,
        xMaxValue: PropTypes.number,
        yMinValue: PropTypes.number,
        yMaxValue: PropTypes.number,
        minDotSizeValue: PropTypes.number,
        maxDotSizeValue: PropTypes.number,
        minColorValue: PropTypes.number,
        maxColorValue: PropTypes.number,
        colorValues: PropTypes.array,

        xAxisExtentFromSampledData: PropTypes.bool, // whether xExtent should be [min, max] of the whole signal or only of the returned docs
        yAxisExtentFromSampledData: PropTypes.bool,
        updateColorOnZoom: PropTypes.bool,
        updateSizeOnZoom: PropTypes.bool,

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
        withTooltip: PropTypes.bool, // prop will get copied to state in constructor, changing it later will not update it, use setWithTooltip method to update it
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

    static defaultProps = { }; // defaults set in ScatterPlotBase

    setView(...args) {
        this.scatterPlotBase.setView(...args);
    }
    getView() { return this.scatterPlotBase.getView(); }
    setMaxDotCount(newValue) {
        this.scatterPlotBase.setMaxDotCount(newValue);
    }
    setWithTooltip(newValue) {
        this.scatterPlotBase.setWithTooltip(newValue);
    }

    render() {
        return (
                <ScatterPlotBase ref={node => this.scatterPlotBase = node} {...this.props} />
        );
    }

    static getQueries = ScatterPlotBase.getQueries;
    static getQueriesForSignalSet = ScatterPlotBase.getQueriesForSignalSet;
    static prepareData = ScatterPlotBase.prepareData;
    static computeExtents = ScatterPlotBase.computeExtents;
    static processDocs = ScatterPlotBase.processDocs;
    static filterData = ScatterPlotBase.filterData;
    static drawChart = ScatterPlotBase.drawChart;
    static drawDots = ScatterPlotBase.drawDots;
    static drawHighlightDot = ScatterPlotBase.drawHighlightDot;
}