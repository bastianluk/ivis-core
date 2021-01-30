"use strict";

import axios from "axios";
import {getUrl} from "./urls";

export async function fetchBuiltinTasks() {
    const data = await axios.get(getUrl(`rest/builtin-tasks`));
    return data.data;
}