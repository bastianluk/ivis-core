'use strict';

function usernameValid(username) {
    return /^[a-zA-Z0-9][a-zA-Z0-9_\-.]*$/.test(username);
}

function isSignalSetAggregationIntervalValid(intervalStr) {
    return /^[1-9]\d*[smhd]$/.test(intervalStr);
}

module.exports = {
    usernameValid,
    isSignalSetAggregationIntervalValid
};