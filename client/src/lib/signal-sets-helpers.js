'use strict';
import {SignalSetType, SignalSetKind} from "../../../shared/signal-sets";

export function getSignalSetTypesLabels(t) {
    return {
        [SignalSetType.NORMAL]: t('Normal'),
        [SignalSetType.COMPUTED]: t('Computed')
    }
}

export function getSignalSetKindsLabels(t) {
    return {
        [SignalSetKind.GENERIC]: t('Generic'),
        [SignalSetKind.TIME_SERIES]: t('Time series'),
    }
}

