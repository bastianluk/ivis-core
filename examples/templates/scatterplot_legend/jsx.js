"use strict";

import React, { Component } from "react";
import { ScatterPlot, Legend, withPanelConfig } from "ivis";

const signalSetsStructure = [
    {
        labelAttr: 'label',
        colorAttr: 'color',
        selectionAttr: 'enabled'
    }
];

@withPanelConfig
export default class ScatterPlotWithLegend extends Component {
    constructor(props) {
        super(props);
    }

    render() {
        const config = this.getPanelConfig(); // gets the current values of panel parameters
        const yearsConfigSpec = this.getPanelConfigSpec()[0]; // gets the specification of 'years' parameter (the first and only parameter of this template)

        const signalSets = [];
        for (const year of config.years) {
            let signalSetConfig = {
                x_sigCid: "income_per_person",
                y_sigCid: "life_expectancy",
                label_sigCid: "country",
                tooltipLabels: {
                    label_format: (year, country) => country + ", " + year,
                    x_label: "Income per person",
                    y_label: y => "Life expectancy: " + y + " years"
                },
                regressions: [ {type: "linear"} ]
            };
            signalSetConfig.label = year.label;
            signalSetConfig.color = year.color;
            signalSetConfig.enabled = year.enabled;
            signalSetConfig.cid = year.sigSetCid;
            signalSets.push(signalSetConfig);
        }
        const cnf = {
            signalSets
        };

        return (
            <>
                <Legend label="Years" configPath={['years']} withSelector structure={signalSetsStructure} withConfiguratorForAllUsers configSpec={yearsConfigSpec}/>
                <ScatterPlot
                    className={"asd"}
                    config={cnf}
                    height={500}
                    margin={{ left: 45, right: 5, top: 5, bottom: 40 }}
                    maxDotCount={100}
                    dotSize={4}
                    xAxisLabel={"Income per person"}
                    yAxisLabel={"Life expectancy"}
                />
            </>
        );
    }
}
