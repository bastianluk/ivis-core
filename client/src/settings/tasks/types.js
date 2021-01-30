'use strict';
import em from '../../../src/lib/extension-manager';

import {TaskType, PythonSubtypes} from "../../../../shared/tasks";
const taskSubtypeLabels = {
    [TaskType.PYTHON]: {
        [PythonSubtypes.ENERGY_PLUS]: 'EnergyPlus task',
        [PythonSubtypes.NUMPY]: 'Numpy task'
    }
};

em.invoke('tasks.installLabels', taskSubtypeLabels);

export function getSubtypeLabel(t, type, subtype) {
    let label = t(subtype);

    if (taskSubtypeLabels[type]) {
        if (taskSubtypeLabels[type][subtype]) {
            label = t(taskSubtypeLabels[type][subtype]);
        }
    }

    return label;
}