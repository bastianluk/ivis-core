'use strict';

import React, {Component} from "react";
import {
    isSignalVisible,
    RenderStatus
} from "./TimeBasedChartBase";
import {getAxisIdx, LineChartBase, lineWithoutPoints} from "./LineChartBase";
import {select} from "d3-selection";
import * as d3Shape
    from "d3-shape";
import {rgb} from "d3-color";
import PropTypes
    from "prop-types";
import tooltipStyles
    from "./Tooltip.scss";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";


@withComponentMixins([
    withTranslation
])
export class StackAreaChart extends Component {
    constructor(props) {
        super(props);

        const t = props.t;

        this.areaPathSelection = {};

        this.boundCreateChart = ::this.createChart;
        this.boundPrepareData = ::this.prepareData;
    }

    static propTypes = {
        config: PropTypes.object.isRequired,
        contentComponent: PropTypes.func,
        contentRender: PropTypes.func,
        onClick: PropTypes.func,
        height: PropTypes.number,
        margin: PropTypes.object,
        withTooltip: PropTypes.bool,
        withBrush: PropTypes.bool,
        tooltipContentComponent: PropTypes.func,
        tooltipContentRender: PropTypes.func,
        tooltipExtraProps: PropTypes.object,
        lineCurve: PropTypes.func,
        signalAgg: PropTypes.string,
        prepareData: PropTypes.func
    }

    static defaultProps = {
        margin: {left: 5, right: 5, top: 5, bottom: 20},
        height: 500,
        withTooltip: true,
        withBrush: true,
        lineCurve: d3Shape.curveLinear,
        signalAgg: 'avg'
    }

    prepareData(base, signalSetsData, extraData) {
        if (this.props.prepareData) {
            this.props.prepareData(base, signalSetsData, extraData);
        }

        const signalSetsReverse = this.props.config.signalSets.slice().reverse();

        for (const setSpec of signalSetsReverse) {
            const signalsReverse = setSpec.signals.slice().reverse();

            const changeData = data => {
                let accumulator = 0;
                for (const sigSpec of signalsReverse) {
                    accumulator += data[sigSpec.cid][this.props.signalAgg];
                    data[sigSpec.cid]._stackAccumulator = data[sigSpec.cid][this.props.signalAgg] ? accumulator : 0;
                }
            };

            const sigSetData = signalSetsData[setSpec.cid];
            if (sigSetData.prev) {
                changeData(sigSetData.prev.data);
            }
            for (const main of sigSetData.main) {
                changeData(main.data);
            }
            if (sigSetData.next) {
                changeData(sigSetData.next.data);
            }
        }

        return {
            signalSetsData: signalSetsData
        };
    }

    createChart(base, signalSetsData, baseState, abs, xScale, yScales, points) {
        for (const sigSetConf of this.props.config.signalSets) {
            if (points[sigSetConf.cid]) {
                for (const sigConf of sigSetConf.signals) {
                    if (isSignalVisible(sigConf)) {
                        const sigCid = sigConf.cid;
                        const yScale = yScales[getAxisIdx(sigConf)];

                        const minMaxArea = d3Shape.area()
                            .x(d => xScale(d.ts))
                            .y0(d => yScale(0))
                            .y1(d => yScale(d.data[sigCid]._stackAccumulator))
                            .curve(this.props.lineCurve);

                        const minMaxAreaColor = rgb(sigConf.color);

                        this.areaPathSelection[sigSetConf.cid][sigCid]
                            .datum(points[sigSetConf.cid])
                            .attr('fill', minMaxAreaColor.toString())
                            .attr('stroke', 'none')
                            .attr('stroke-linejoin', 'round')
                            .attr('stroke-linecap', 'round')
                            .attr('d', minMaxArea);
                    }
                }
            }
        }

        return RenderStatus.SUCCESS;
    }

    render() {
        const props = this.props;

        function getSignalValuesForDefaultTooltip(tooltipContent, sigSetConf, sigConf, sigSetCid, sigCid, signalData) {
            const val = signalData[this.props.signalAgg];

            const unit = sigConf.unit;

            return (
                <span className={tooltipStyles.signalVal}>{val} {unit}</span>
            );
        }

        for (const sigSetConf of props.config.signalSets) {
            this.areaPathSelection[sigSetConf.cid] = {};
        }

        return (
            <LineChartBase
                config={props.config}
                height={props.height}
                margin={props.margin}
                signalAggs={[props.signalAgg]}
                lineAgg={props.signalAgg}
                getSignalValuesForDefaultTooltip={getSignalValuesForDefaultTooltip.bind(this)}
                prepareData={this.boundPrepareData}
                createChart={this.boundCreateChart}
                getSignalGraphContent={(base, sigSetCid, sigCid) => <path
                    ref={node => this.areaPathSelection[sigSetCid][sigCid] = select(node)}/>}
                withTooltip={props.withTooltip}
                withBrush={props.withBrush}
                contentComponent={props.contentComponent}
                contentRender={props.contentRender}
                tooltipContentComponent={props.tooltipContentComponent}
                tooltipContentRender={props.tooltipContentRender}
                tooltipExtraProps={props.tooltipExtraProps}
                getLineColor={color => color.darker()}
                lineVisibility={lineWithoutPoints}
                lineCurve={props.lineCurve}
                withZoom={true}
            />
        );
    }
}
