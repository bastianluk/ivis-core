'use strict';

import React, {Component} from "react";
import {BubblePlot, TimeContext, TimeRangeSelector, IntervalSpec} from "ivis";
import * as d3Format from "d3-format";

export default class HansRoslingBubblePlot extends Component {
    constructor(props) {
        super(props);
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

        return (
            <TimeContext initialIntervalSpec={new IntervalSpec("1953-10-30", "1966-04-01", null, null)}>
                <TimeRangeSelector/>
                <BubblePlot
                    config={cnf}
                    height={600}
                    margin={{ left: 45, right: 5, top: 5, bottom: 40 }}
                    maxDotCount={200}
                    maxDotSize={30}
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
                />
            </TimeContext>
        );
    }
}