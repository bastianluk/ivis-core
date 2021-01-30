'use strict';
import {SignalType, SignalSource} from "../../../../../shared/signals";

export function getSignalTypes(t) {
    return {
        [SignalType.INTEGER]: t('Integer'),
        [SignalType.LONG]: t('Long'),
        [SignalType.FLOAT]: t('Float'),
        [SignalType.DOUBLE]: t('Double'),
        [SignalType.BOOLEAN]: t('Boolean'),
        [SignalType.KEYWORD]: t('Keyword'),
        [SignalType.TEXT]: t('Text'),
        [SignalType.DATE_TIME]: t('Date/Time'),
        [SignalType.JSON]: t('JSON'),
    }
}

export function getSignalSources(t) {
    return {
        [SignalSource.RAW]: t('Raw'),
        [SignalSource.JOB]: t('Job'),
        [SignalSource.DERIVED]: t('Derived'),
    }
}
