'use strict';

import React, {Component} from "react";
import * as d3Scheme from "d3-scale-chromatic";
import {withErrorHandling} from "../lib/error-handling";
import PropTypes from "prop-types";
import {withComponentMixins} from "../lib/decorator-helpers";
import {withTranslation} from "../lib/i18n";
import {PropType_d3Color, PropType_d3Color_Required} from "../lib/CustomPropTypes";
import {StaticBarChart} from "./BarChart";
import {FrequencyDataLoader} from "./FrequencyDataLoader";
import StatusMsg from "./StatusMsg";

@withComponentMixins([
    withTranslation,
    withErrorHandling
])
export class FrequencyBarChart extends Component {
    constructor(props) {
        super(props);

        const t = props.t;
        this.state = {
            data: null,
            statusMsg: t('Loading...')
        };
    }

    static propTypes = {
        config: PropTypes.shape({
            sigSetCid: PropTypes.string.isRequired,
            sigCid: PropTypes.string.isRequired,
            tsSigCid: PropTypes.string
        }).isRequired,
        colors: PropTypes.arrayOf(PropType_d3Color_Required()),
        getLabel: PropTypes.func, // (key, count) => label
        getColor: PropTypes.func, // chooses color from index: (props.color, index) => color
        maxBucketCount: PropTypes.number,
        otherLabel: PropTypes.string,
        otherColor: PropType_d3Color(),
        // for Bar chart
        height: PropTypes.number.isRequired,
        margin: PropTypes.object,
        padding: PropTypes.number,
        withTooltip: PropTypes.bool,
        withTransition: PropTypes.bool,
        withZoom: PropTypes.bool,

        className: PropTypes.string,
        style: PropTypes.object
    };

    static defaultProps = {
        getLabel: (key, count) => key,
        getColor: (colors, index) => colors[index % colors.length], // colors = this.props.colors
        colors: d3Scheme.schemeCategory10,
        withZoom: false,
        otherLabel: "Other"
    };

    componentDidUpdate(prevProps, prevState) {
        if (this.props.colors.length === 0)
            throw new Error("FrequencyPieChart: 'colors' prop must contain at least one element. You may omit it completely for default value.");

        if (!Object.is(prevProps.colors, this.props.colors))
            this.dataLoader.reloadData();
    }

    processData(data) {
        if (data.buckets.length === 0) {
            this.setState({
                data: null,
                statusMsg: this.props.t('No data.')
            });
        } else {
            let bars = data.buckets.map((b, i) => {
                return {
                    label: this.props.getLabel(b.key, b.count),
                    color: this.props.getColor(this.props.colors, i),
                    value: b.count
                }
            });
            if (data.sum_other_doc_count && this.props.otherLabel)
                bars.push({
                    label: this.props.otherLabel,
                    color: this.props.otherColor !== undefined ? this.props.otherColor : getColor(this.props.colors, bars.length),
                    value: data.sum_other_doc_count
                });
            this.setState({
                data: {bars}
            });
        }
    }

    render() {
        let chart;
        if (!this.state.data) {
            chart = (
                <svg ref={node => this.containerNode = node} height={this.props.height} width="100%">
                    <StatusMsg>
                        {this.state.statusMsg}
                    </StatusMsg>
                </svg>
            );

        } else {
            chart = (
                <StaticBarChart
                    height={this.props.height}
                    config={this.state.data}
                    margin={this.props.margin}
                    padding={this.props.padding}
                    withTooltip={this.props.withTooltip}
                    withTransition={this.props.withTransition}
                    withZoom={this.props.withZoom}
                    minValue={0}
                />
            );

        }
        return (
            <div className={this.props.className} style={this.props.style}>
                <FrequencyDataLoader ref={(node) => this.dataLoader = node}
                                     config={this.props.config}
                                     processData={::this.processData}
                                     maxBucketCount={this.props.maxBucketCount}/>
                {chart}
            </div>
        );
    }
}
