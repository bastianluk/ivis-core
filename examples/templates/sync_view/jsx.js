'use strict';

import React, {Component} from "react";
import {ScatterPlot, HistogramChart, withPanelConfig, TimeContext, IntervalSpec, TimeRangeSelector, MinMaxLoader} from "ivis";

@withPanelConfig
export default class SynchronizedViews extends Component {
    constructor(props) {
        super(props);

        this.state = {
            xMinValue: null,
            xMaxValue: null
        }
    }

    viewChanged(target, view, causedByUser) {
        if (!causedByUser)
            return;

        this.scatter.setView(view.xMin, view.xMax, undefined, undefined, target);
        this.histogram.setView(view.xMin, view.xMax, target);
    }

    processMinMaxResults(results) {
        const config = this.getPanelConfig();
        this.setState({
            xMinValue: results[config.x_sigCid].min,
            xMaxValue: results[config.x_sigCid].max
        });
    }

    extentWithMargin(min, max, margin_percentage) {
        const diff = max - min;
        const margin = diff * margin_percentage;
        return [min - margin, max + margin];
    }

    render() {
        const config = this.getPanelConfig();
        const color = "#448e7c";

        const scatter_config = {
            signalSets: [{
                cid: config.sigSet,
                x_sigCid: config.x_sigCid,
                y_sigCid: config.y_sigCid,
                tsSigCid: config.tsSigCid,
                label_sigCid: config.label_sigCid,
                color: color,
                globalDotShape: "circle"
            }]
        };
        const histogram_config = {
            sigSetCid: config.sigSet,
            sigCid: config.x_sigCid,
            tsSigCid: config.tsSigCid,
            color: color
        };
        const margin = {
            left: 40, right: 5, top: 5, bottom: 20
        };
        const [xMinValue, xMaxValue] = this.extentWithMargin(this.state.xMinValue, this.state.xMaxValue, 0.02);

        let charts;
        if (this.state.xMinValue === null || this.state.xMaxValue === null)
            charts = <div style={{textAlign: 'center'}}>No data.</div>
        else
            charts = (<>
                <ScatterPlot config={scatter_config}
                             height={400}
                             margin={margin}
                             maxDotCount={200}
                             dotSize={3}
                             xMinValue={xMinValue}
                             xMaxValue={xMaxValue}
                             withToolbar={false}
                             viewChangeCallback={::this.viewChanged}
                             ref={node => this.scatter = node}
                />
                <HistogramChart config={histogram_config}
                                height={200}
                                margin={margin}
                                xMinValue={xMinValue}
                                xMaxValue={xMaxValue}
                                topPaddingWhenZoomed={0.25}
                                viewChangeCallback={::this.viewChanged}
                                ref={node => this.histogram = node}
                />
            </>)

        return (
            <TimeContext initialIntervalSpec={new IntervalSpec("2003-10-30", "2016-04-01", null, null)}>
                <TimeRangeSelector/>

                <MinMaxLoader
                    config={{
                        sigSetCid: config.sigSet,
                        sigCids: config.x_sigCid,
                        tsSigCid: config.tsSigCid
                    }}
                    processData={::this.processMinMaxResults} // the :: operator is a shortcut for 'bind' method, so when the 'processMinMaxResults' is called (from inside MinMaxLoader), 'this' inside it is set to this class
                />

                {charts}
            </TimeContext>);
    }
}