'use strict';
import React, {Component} from "react";

export default class StatusMsg extends Component{
    render() {
        return (
            <text textAnchor="middle" x="50%" y="50%"
                  fontFamily="'Open Sans','Helvetica Neue',Helvetica,Arial,sans-serif"
                  fontSize="14px"
                  fill="currentColor">
                {this.props.children}
            </text>
        )
    }
}