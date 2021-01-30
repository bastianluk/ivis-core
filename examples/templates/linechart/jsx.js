'use strict';

import React, {Component} from "react";
import { withPanelConfig, TimeContext, TimeRangeSelector, LineChart, Legend } from "ivis";

const sensorsStructure = [
    {
        labelAttr: 'label',
        colorAttr: 'color',
        selectionAttr: 'enabled'
    }
];

@withPanelConfig
export default class LineChartTemplate extends Component {
    render() {
        const config = this.getPanelConfig();

        // convert sensors from parameters to signalSets
        const signalSets = [];
        for (const sensor of config.sensors) {
            // this allows to have the same sigSet in more than one sensor
            let signalSet = signalSets.find(s => s.cid === sensor.sigSet);
            if (signalSet === undefined) {
                signalSet = {
                    cid: sensor.sigSet,
                    signals: [],
                    tsSigCid: sensor.tsSigCid
                }
                signalSets.push(signalSet);
            }
            signalSet.signals.push({
                    label: sensor.label,
                    color: sensor.color,
                    cid: sensor.signal,
                    enabled: sensor.enabled,
                }
            );
        }

        return (
            <TimeContext>
                <TimeRangeSelector/>
                <Legend label="Sensors" configPath={['sensors']} withSelector structure={sensorsStructure} />
                <LineChart
                    config={{signalSets}}
                    height={500}
                    margin={{ left: 40, right: 5, top: 5, bottom: 20 }}
                    tooltipExtraProps={{ width: 450 }}
                />
            </TimeContext>
        );
    }
}
