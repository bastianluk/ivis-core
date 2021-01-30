'use strict';

import React, {Component} from "react";
import {TimeRangeSelector, TimeContext, IntervalSpec, HistogramChart} from "ivis";
import {rgb} from "d3-color";
import * as d3Format from "d3-format";

export default class HistogramWithSum extends Component {
    constructor(props) {
        super(props);
    }

    render() {
        const cnf = {
            sigSetCid: "top:gapminder",
            sigCid: "life_expectancy",
            tsSigCid: "year",
            metric_sigCid: "population",
            metric_type: "sum",
            color: rgb(0, 87, 219),
            xAxisLable: "Life expectancy"
        };

        return (
            <TimeContext initialIntervalSpec={new IntervalSpec("2003-10-30", "2016-04-01", null, null)}>
                <TimeRangeSelector/>
                <HistogramChart
                    config={cnf}
                    height={400}
                    margin={{left: 40, right: 5, top: 5, bottom: 20}}
                    topPaddingWhenZoomed={0.1}
                    tooltipFormat={bucket => <>
                        Sum of populations: {d3Format.format(",")(bucket.metric)}<br/>
                        Count: {bucket.count}
                    </>}
                />
            </TimeContext>
        );
    }
}