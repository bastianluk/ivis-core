'use strict';

import * as d3Array from "d3-array";
import * as d3Scale from "d3-scale";
import * as d3Color from "d3-color";
import * as d3Selection from "d3-selection";
import * as d3Interpolate from "d3-interpolate";
import * as d3Zoom from "d3-zoom";

/**
 * Adds margin to extent in format of d3.extent()
 */
export function extentWithMargin(extent, margin_percentage) {
    const diff = extent[1] - extent[0];
    const margin = diff * margin_percentage;
    return [extent[0] - margin, extent[1] + margin];
}

export function getExtent(setsData, valueof) {
    const min = d3Array.min(setsData, function(data) {
        return d3Array.min(data, valueof);
    });
    const max = d3Array.max(setsData, function(data) {
        return d3Array.max(data, valueof);
    });
    return [min, max];
}

export function isInExtent(value, extent) {
    return value >= extent[0] && value <= extent[1];
}

export function isSignalVisible(sigConf) {
    if (!sigConf) return false;
    return (!('enabled' in sigConf) || sigConf.enabled);
}

/**
 * Computes Euclidean distance of two points
 * @param point1 object in format {x,y}
 * @param point2 object in format {x,y}
 */
export function distance(point1, point2) {
    return Math.hypot(point1.x - point2.x, point1.y - point2.y);
}

export function roundTo(num, decimals = 2) {
    const pow10 = Math.pow(10, decimals);
    return Math.round(num * pow10) / pow10;
}

export function getColorScale(domain, colors) {
    if (!Array.isArray(colors) || colors.length === 0)
        throw new Error("colors parameter must be an array with at least one element");
    colors = colors.length === 1 ? [colors[0], colors[0]] : colors; // if we have only one color, duplicate it

    const [min, max] = domain;
    const step = (max - min) / (colors.length - 1);
    const subdividedDomain = colors.map((c, i) => i * step + min); // subdividedDomain contains a value from [min, max] for each color (domain and range of scaleLinear must have same length)
    return d3Scale.scaleLinear()
        .domain(subdividedDomain)
        .range(colors);
}

export function ModifyColorCopy(color, new_opacity) {
    color = d3Color.color(color);
    // noinspection JSIncompatibleTypesComparison
    if (color === null)
        return undefined;
    if (new_opacity === undefined)
        new_opacity = color.opacity;
    return d3Color.rgb(color.r, color.g, color.b, new_opacity);
}

export function brushHandlesLeftRight(group, selection, ySize) {
    group.selectAll(".handle--custom")
        .data([{type: "w"}, {type: "e"}])
        .join(
            enter => enter.append("rect")
                .attr("class", d => `handle--custom handle--custom--${d.type}`)
                .attr("fill", "#434343")
                .attr("cursor", "ew-resize")
                .attr("x", "-5px")
                .attr("width", "10px")
                .attr("y", ySize / 4)
                .attr("height", ySize / 2)
                .attr("rx", "5px")
        )
        .attr("display", selection === null ? "none" : null)
        .attr("transform", selection === null ? null : (d, i) => `translate(${selection[i]},0)`);
}

export function brushHandlesTopBottom(group, selection, xSize) {
    group.selectAll(".handle--custom")
        .data([{type: "n"}, {type: "s"}])
        .join(
            enter => enter.append("rect")
                .attr("class", d => `handle--custom handle--custom--${d.type}`)
                .attr("fill", "#434343")
                .attr("cursor", "ns-resize")
                .attr("y", "-5px")
                .attr("height", "10px")
                .attr("x", xSize / 4)
                .attr("width", xSize / 2)
                .attr("ry", "5px")
        )
        .attr("display", selection === null ? "none" : null)
        .attr("transform", selection === null ? null : (d, i) => `translate(0, ${selection[i]})`);
}

/** https://github.com/d3/d3-zoom#zoom_wheelDelta with multiplied values */
export function WheelDelta(multiplier = 2) {
    return () => -d3Selection.event.deltaY * multiplier * (d3Selection.event.deltaMode === 1 ? 0.05 : d3Selection.event.deltaMode ? 1 : 0.002);
}

export function transitionInterpolate(selection, prevTransform, newTransform, setZoomTransform, endCallback, duration = 150, prevZoomYScaleMultiplier, newZoomYScaleMultiplier) {
    const xInterpolate = d3Interpolate.interpolate(prevTransform.x, newTransform.x);
    const yInterpolate = d3Interpolate.interpolate(prevTransform.y, newTransform.y);
    const kInterpolate = d3Interpolate.interpolate(prevTransform.k, newTransform.k);
    const mInterpolate = d3Interpolate.interpolate(prevZoomYScaleMultiplier, newZoomYScaleMultiplier);

    return selection.transition().duration(duration)
        .tween("zoom", () => function (t) {
            setZoomTransform(d3Zoom.zoomIdentity.translate(xInterpolate(t), yInterpolate(t)).scale(kInterpolate(t)), mInterpolate(t));
        })
        .on("end", endCallback);
}

export function setZoomTransform(self, setStateCallback) {
    return function (transform, zoomYScaleMultiplier) {
        if (zoomYScaleMultiplier)
            self.setState({
                zoomTransform: transform,
                zoomYScaleMultiplier: zoomYScaleMultiplier
            }, setStateCallback);
        else
            self.setState({
                zoomTransform: transform
            }, setStateCallback);
    }
}

export const ZoomEventSources = ["mousemove", "dblclick", "wheel", "touchstart", "touchmove" ]; // source: https://github.com/d3/d3-zoom#api-reference (table with events - causing "zoom" event)

export function AreZoomTransformsEqual(a, b, scale_epsilon = 0.001, translate_epsilon = 0.01) {
    if (!(a.hasOwnProperty("x") && a.hasOwnProperty("y") && a.hasOwnProperty("k"))) return false;
    if (!(b.hasOwnProperty("x") && b.hasOwnProperty("y") && b.hasOwnProperty("k"))) return false;
    if (Math.abs(a.k - b.k) > scale_epsilon) return false;
    if (Math.abs(a.x - b.x) > translate_epsilon) return false;
    if (Math.abs(a.y - b.y) > translate_epsilon) return false;
    return true;
}

/**
 * Helper function to draw a set of rectangles to a D3 selection
 * @param data - array of values
 * @param selection - D3 selection
 * @param x_position - value or function (evaluated with each datum)
 * @param y_position - value or function (evaluated with each datum)
 * @param width - value or function (evaluated with each datum)
 * @param height - value or function (evaluated with each datum)
 * @param color - color of bars - value or function (evaluated with each datum)
 * @param key - see https://github.com/d3/d3-selection#selection_data
 */
export function drawBars(data, selection, x_position, y_position, width, height, color, key) {
    const bars = selection
        .selectAll('rect')
        .data(data, key || (d => d));

    bars.enter()
        .append('rect')
        .merge(bars)
        .attr('x', x_position)
        .attr('y', y_position)
        .attr("width", width)
        .attr("height", height)
        .attr("fill", color);

    bars.exit()
        .remove();
}

export {curveVerticalStep} from "../lib/d3-shape_step_vertical";

export const ConfigDifference = {
    // We assume here order from the most benign to the worst
    NONE: 0,
    RENDER: 1,
    DATA: 2,
    DATA_WITH_CLEAR: 3
};

/**
 * Test if time interval changed
 * @param self          the chart object, must use the intervalAccessMixin
 * @returns {number}    ConfigDifference
 */
export function TimeIntervalDifference(self, props) {
    const prevAbs = self.getIntervalAbsolute(props);
    const prevSpec = self.getIntervalSpec(props);

    if (prevSpec !== self.getIntervalSpec()) {
        return ConfigDifference.DATA_WITH_CLEAR;
    } else if (prevAbs !== self.getIntervalAbsolute()) { // If its just a regular refresh, don't clear the chart
        return ConfigDifference.DATA;
    }
    return ConfigDifference.NONE;
}

