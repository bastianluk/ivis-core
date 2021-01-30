'use strict';

import React, {Component} from "react";
import {BubblePlot, TimeContext, TimeRangeSelector, IntervalSpec} from "ivis";
import * as d3Format from "d3-format";
import * as d3Scale from "d3-scale";

export default class HansRoslingBubblePlot extends Component {
    constructor(props) {
        super(props);

        this.minDotSize = 2;
        this.maxDotSize = 30;

        this.state = {
            minPopulationValue: null,
            maxPopulationValue: null
        }
    }

    generateLegend() {
        const legend = [];
        if (this.state.minPopulationValue === null || this.state.maxPopulationValue === null)
            return legend;

        const sizeScale = d3Scale.scaleSqrt()
            .domain([this.state.minPopulationValue, this.state.maxPopulationValue])
            .range([this.minDotSize, this.maxDotSize])
            .nice();
        const ticks = sizeScale.ticks(4);

        for (const [i, tick] of ticks.entries()) {
            const radius = sizeScale(tick);
            legend.push(
                <svg key={i} height={2 * this.maxDotSize} width={tick === 0 ? 80 : 180} >
                    <circle  cx={radius} cy={this.maxDotSize} r={radius} fill={"#3d3d3d"} />
                    <text y={this.maxDotSize} x={2 * radius + 10} dominantBaseline="middle">
                        {d3Format.format(",")(tick)}
                    </text>
                </svg>
            );
        }
        return legend;
    }

    computeExtents(base, processedResults, results, queries, additionalInformation) {
        const extents = BubblePlot.computeExtents(base, processedResults, results, queries, additionalInformation);

        const sizeExtent = extents[2];
        this.setState({
            minPopulationValue: sizeExtent[0],
            maxPopulationValue: sizeExtent[1]
        });

        return extents;
    }

    drawHighlightDot(base, record, selection, xScale, yScale, sScale, cScale) {
        selection.selectAll("circle").remove();
        if (record) {
            selection.append("circle")
                .attr('cx', xScale(record.x))
                .attr('cy', yScale(record.y))
                .attr("r", sScale(record.s))
                .attr("stroke", "#3d3d3d")
                .attr("stroke-width", 1)
                .attr('fill', cScale(record.d));
        }
    }

    render() {
        const cnf = {
            signalSets: [{
                cid: "top:gapminder",
                x_sigCid: "fertility_rate",
                y_sigCid: "life_expectancy",
                colorDiscrete_sigCid: "region",
                dotSize_sigCid: "population",
                tsSigCid: "year",
                label_sigCid: "country",
                tooltipLabels: {
                    x_label: null,
                    y_label: null,
                    color_label: null,
                    dotSize_label: p => "Population: " + d3Format.format(",")(p)
                },
                globalDotShape: "circle",
                getGlobalDotColor: color => color
            }]
        };

        const legend = this.generateLegend();

        return (
            <TimeContext initialIntervalSpec={new IntervalSpec("1953-10-30", "1966-04-01", null, null)}>
                <TimeRangeSelector/>
                <BubblePlot
                    config={cnf}
                    height={600}
                    margin={{ left: 45, right: 5, top: 5, bottom: 40 }}
                    maxDotCount={200}
                    minDotSize={this.minDotSize}
                    maxDotSize={this.maxDotSize}
                    colorValues={["europe", "americas", "africa", "asia"]}
                    xMinValue={0.5}
                    xMaxValue={8.7}
                    yMinValue={20}
                    yMaxValue={87}
                    xAxisLabel={"Fertility rate"}
                    yAxisLabel={"Life expectancy"}
                    withToolbar={false}
                    zoomLevelMax={3}
                    highlightDotSize={1}
                    computeExtents={::this.computeExtents}
                    drawHighlightDot={::this.drawHighlightDot}
                />

                <h5>Population:</h5>
                <div id={"legend"}
                     style={{
                         display: "flex",
                         justifyContent: "center"
                     }}>
                    {legend}
                </div>
            </TimeContext>
        );
    }
}