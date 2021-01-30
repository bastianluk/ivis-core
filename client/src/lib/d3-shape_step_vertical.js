/*
 *  Modified copy of step.js file from d3-shape
 *  (Latest commit e3b1b0a on May 21, 2016)
 *  https://github.com/d3/d3-shape/blob/master/src/curve/step.js
 *
 *  The original step function creates the steps along the horizontal axis, we need them along the vertical.
 */

function Step(context, t) {
    this._context = context;
    this._t = t;
}

Step.prototype = {
    areaStart: function() {
        this._line = 0;
    },
    areaEnd: function() {
        this._line = NaN;
    },
    lineStart: function() {
        this._x = this._y = NaN;
        this._point = 0;
    },
    lineEnd: function() {
        if (0 < this._t && this._t < 1 && this._point === 2) this._context.lineTo(this._x, this._y);
        if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath();
        if (this._line >= 0) this._t = 1 - this._t, this._line = 1 - this._line;
    },
    point: function(x, y) {
        x = +x, y = +y;
        switch (this._point) {
            case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break;
            case 1: this._point = 2; // proceed
            default: {
                if (this._t <= 0) {
                    this._context.lineTo(this._x, y);
                    this._context.lineTo(x, y);
                } else {
                    // modification start
                    var y1 = this._y * (1 - this._t) + y * this._t;
                    this._context.lineTo(this._x, y1);
                    this._context.lineTo(x, y1);
                    // modification end
                }
                break;
            }
        }
        this._x = x, this._y = y;
    }
};

// modified export
export function curveVerticalStep(context) {
    return new Step(context, 0.5);
}