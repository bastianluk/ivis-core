'use strict';

const knex = require('../lib/knex');
const {getVirtualNamespaceId} = require("../../shared/namespaces");
const {TaskSource, BuildState, TaskType} = require("../../shared/tasks");
const em = require('../lib/extension-manager');

const aggregationTask = {
    name: 'aggregation',
    description: 'Task used by aggregation feature for signal sets',
    type: TaskType.PYTHON,
    settings: {
        params: [{
            "id": "signalSet",
            "type": "signalSet",
            "label": "Signal Set",
            "help": "Signal set to aggregate",
            "includeSignals": true
        }, {
            "id": "ts",
            "type": "signal",
            "signalSetRef": "signalSet",
            "label": "Timestamp signal",
            "help": "Timestamp for aggregation"
        }, {
            "id": "offset",
            "type": "string",
            "label": "Offset",
            "help": "Since when should aggregation be done"
        }, {
            "id": "interval",
            "type": "string",
            "label": "Interval",
            "help": "Bucket interval"
        }],
        code: `from ivis import ivis

es = ivis.elasticsearch
state = ivis.state
params= ivis.parameters
entities= ivis.entities
#owned= ivis.owned

sig_set_cid = params['signalSet']
sig_set = entities['signalSets'][sig_set_cid]
ts = entities['signals'][sig_set_cid][params['ts']]
interval = params['interval']
offset = params['offset']

agg_set_cid =  f"aggregation_{interval}_{sig_set_cid}"

numeric_signals = { cid: signal for (cid,signal) in entities['signals'][sig_set_cid].items() if (signal['type'] in ['integer','long','float','double']) }

if state is None or state.get(agg_set_cid) is None:
  ns = sig_set['namespace']
    
  signals= []
  for cid, signal in numeric_signals.items():
    signal_base = {
      "cid": signal['cid'],
      "name": signal['name'],
      "description": signal['description'],
      "namespace": signal['namespace'],
      "type": signal['type'],
      "indexed": signal['indexed'],
      "settings": signal['settings']
    }
    signals.append(signal_base)
  
  # Cid is important it is used in the system to identify related signals
    for stat in ['min', 'max', 'count', 'sum']:
      signal = signal_base.copy()
      signal.update({
        "cid": f"_{signal_base['cid']}_{stat}",
        "name": f"{stat} of {signal_base['cid']}",
        "description": f"Stat {stat} for aggregation of signal '{signal_base['cid']}'"
      })
      signals.append(signal)

  signals.append({
      "cid": ts['cid'],
      "name": ts['name'],
      "description": ts['description'],
      "namespace": ts['namespace'],
      "type": ts['type'],
      "indexed": ts['indexed'],
      "settings": ts['settings']
  })

  state = ivis.create_signal_set(
    agg_set_cid,
    ns,
    agg_set_cid,
    f"aggregation with interval '{interval}' for signal set '{sig_set_cid}'",
    None,
    signals)
    
  state['last'] = None
  ivis.store_state(state)
  
if state is not None and state.get('last') is not None:
  last = state['last']
  filter = {
    "range": {
      ts['field']: {
        "gte" : last
      }
    }
  }

  es.delete_by_query(index=state[agg_set_cid]['index'], body={
    "query": { 
      "match": {
        state[agg_set_cid]['fields']['ts']: last
      }
    }
  })
  
else:
  if offset is not None:
    filter = {
      "range": {
        ts['field']: {
          "gte": offset,
          "format":  "yyyy-MM-dd HH:mm:ss"
        }
      }
    } 
  else:
    filter = {'match_all': {}}

query_content = {
  "bool": {
    "filter": filter
  }
}

stat_aggs = {}
for cid, signal in numeric_signals.items():
  stat_aggs[cid] = {
    "stats": {
      "field": signal['field']
    }
  }
 
# interval is deprecated in the newer elasticsearch, instead fixed_interval should be used
query = {
  'size': 0,
  'query': query_content,
  "aggs": {
    "sig_set_aggs": {
      "date_histogram": {
        "field": ts['field'],
        "interval": interval
      },
      "aggs": stat_aggs
    }
  }
}

res = es.search(index=sig_set['index'], body=query)

for hit in res['aggregations']['sig_set_aggs']['buckets']:
  last = hit['key_as_string']
  doc = {}
  for cid in numeric_signals.keys():
    doc[state[agg_set_cid]['fields'][f"_{cid}_min"]]= hit[cid]['min']
    doc[state[agg_set_cid]['fields'][cid]]= hit[cid]['avg']
    doc[state[agg_set_cid]['fields'][f"_{cid}_max"]]= hit[cid]['max']
    doc[state[agg_set_cid]['fields'][f"_{cid}_count"]]= hit[cid]['count']
    doc[state[agg_set_cid]['fields'][f"_{cid}_sum"]]= hit[cid]['sum']
  
  doc[state[agg_set_cid]['fields'][ts['cid']]] = last
  res = es.index(index=state[agg_set_cid]['index'], id=last, doc_type='_doc', body=doc)


state['last'] = last
ivis.store_state(state)`
    },
};

const flattenTask = {
    name: 'Flatten',
    description: 'Task will combine specified signals into single signal set and resolve conflicts on the same time point with the chosen method',
    type: TaskType.PYTHON,
    settings: {
        params: [
            {
                "id": "resolutionMethod",
                "type": "option",
                "label": "Resolution method",
                "help": "Conflict resolution method",
                "options": [
                    {
                        "key": "avg",
                        "label": "Avarage"
                    },
                    {
                        "key": "min",
                        "label": "Minimum"
                    },
                    {
                        "key": "max",
                        "label": "Maximum"
                    }
                ]
            },
            {
                "id": "sets",
                "label": "Signal sets",
                "help": "Signal sets to flatten",
                "type": "fieldset",
                "cardinality": "2..n",
                "children": [
                    {
                        "id": "cid",
                        "label": "Signal set",
                        "type": "signalSet"
                    },
                    {
                        "id": "ts",
                        "type": "signal",
                        "label": "Timestamp",
                        "cardinality": "1",
                        "signalSetRef": "cid"
                    },
                    {
                        "id": "signals",
                        "type": "signal",
                        "label": "Signals",
                        "cardinality": "1..n",
                        "signalSetRef": "cid"
                    }
                ]
            },
            {
                "id": "signalSet",
                "label": "New signal set properties",
                "help": "Resulting signal set",
                "type": "fieldset",
                "cardinality": "1",
                "children": [
                    {
                        "id": "cid",
                        "label": "CID",
                        "type": "string",
                        "isRequired": true
                    },
                    {
                        "id": "namespace",
                        "label": "Namespace",
                        "help": "id of namespace",
                        "type": "number"
                    },
                    {
                        "id": "name",
                        "label": "Name",
                        "type": "string"
                    },
                    {
                        "id": "description",
                        "label": "Description",
                        "type": "string"
                    }
                ]
            }
        ],
        code: `

from ivis import ivis
from elasticsearch import helpers

es = ivis.elasticsearch
state = ivis.state

params = ivis.parameters
entities = ivis.entities
owned = ivis.owned

sig_set = params['signalSet']
sig_set['namespace'] = sig_set['namespace'] if sig_set['namespace'].isdigit() else 1

method = params['resolutionMethod']
sets = params['sets']

if owned['signalSets'].get(sig_set['cid']) is None:
  ns = sig_set['namespace']

  signals= {}
  for sigSet in sets:
    for signal in sigSet['signals']:
      if signals.get(signal) is not None:
        if signals[signal]['type'] != entities['signals'][sigSet['cid']][signal]['type']:
          raise Exception(f"Signals with same cid have to share type")
      else:
        signals[signal] = entities['signals'][sigSet['cid']][signal]

  state = ivis.create_signal_set(sig_set['cid'],sig_set['namespace'],sig_set['name'], sig_set['description'], None, list(signals.values()))
    
  ivis.store_state(state)
  
last = None
if state is not None and state.get('last') is not None:
  last = state['last']
  query_content = {
    "bool": {
      "filter": { 
        "bool": {
          "should": [{"range": { entities['signals'][sigSet['cid']][sigSet['ts']]['field']: { "gte": last}}}  for sigSet in sets]
              #{"range": { entities['signals'][sets[0]['cid']]['ts']['field']: { "gte": "2020-08-17" }}},
          }
        }
    }
  }

  
else:
  print('u')
  query_content = {'match_all': {}}



indices=",".join([entities['signalSets'][sigSet["cid"]]['index'] for sigSet in sets])


query= {
  "sort" : [
     {"_script" : {
      "type" : "number",
      "script" : {
        "lang": "painless",
        "source": """
          long epoch = 0;
          for (int i = 0; i < params.tsSigs.length; i++) {
            if (doc.containsKey(params.tsSigs[i])) {
             epoch = doc[params.tsSigs[i]].value.toInstant().toEpochMilli();
             break;
            }
          }
          return epoch;
          """,
        "params" : {
          "tsSigs" : [entities['signals'][sigSet["cid"]][sigSet["ts"]]['field']  for sigSet in sets]
        }
      },
      "order" : "asc"
    }}
    #{entities['signals'][sets[0]['cid']]['ts']['field'] : {"order" : "asc"}},
    #{ entities['signals'][sets[1]['cid']]['ts']['field'] : {"order" : "asc"}}
  ],
  'query': query_content
}

i=0
for hit in helpers.scan(
    es, 
    index=indices,
    preserve_order=True,
    query=query, 
    scroll='5m', 
    size=1000):
  
  time=hit['_id']


print(time)
print(indices)
quit()


for hit in res['aggregations']['stats']['buckets']:
  last = hit['key_as_string']
  doc = {
    state['aggs']['fields']['ts']: last,
    state['aggs']['fields']['min']: hit['min']['value'],
    state['aggs']['fields']['avg']: hit['avg']['value'],
    state['aggs']['fields']['max']: hit['max']['value']
  }
  res = es.index(index=state['aggs']['index'], doc_type='_doc', body=doc)

# Request to store state
state['last'] = last
ivis.store_state(state)
`
    },
};
/**
 * All default builtin tasks
 */
const builtinTasks = [
    aggregationTask,
    flattenTask
];

em.on('builtinTasks.add', addTasks);

async function getBuiltinTask(name) {
    return await knex.transaction(async tx => {
        return await checkExistence(tx, name)
    });
}

/**
 * Check if builtin in task with fiven name alredy exists
 * @param tx
 * @param name
 * @return {Promise<any>} undefined if not found, found task otherwise
 */
async function checkExistence(tx, name) {
    return await tx('tasks').where({
        source: TaskSource.BUILTIN,
        name: name
    }).first();
}

/**
 * Store given task as a builtin task to system
 * @param tx
 * @param builtinTask task to add
 * @return {Promise<void>}
 */
async function addBuiltinTask(tx, builtinTask) {
    const task = {...builtinTask};
    task.source = TaskSource.BUILTIN;
    task.namespace = getVirtualNamespaceId();
    task.settings = JSON.stringify(task.settings);
    task.build_state = BuildState.UNINITIALIZED;
    await tx('tasks').insert(task);
}

/**
 * Update existing task
 * @param tx
 * @param id of existing task
 * @param builtinTask columns being updated
 * @return {Promise<void>}
 */
async function updateBuiltinTask(tx, id, builtinTask) {
    const task = {...builtinTask};
    task.source = TaskSource.BUILTIN;
    task.namespace = getVirtualNamespaceId();
    task.settings = JSON.stringify(task.settings);
    await tx('tasks').where('id', id).update({...task, build_state: BuildState.UNINITIALIZED});
}

/**
 * Check if all default builtin tasks are in the system / set them to default state
 * @return {Promise<void>}
 */
async function storeBuiltinTasks() {
    await addTasks(builtinTasks);
}

/**
 * Add given tasks as builtin tasks
 * @param tasks
 * @return {Promise<void>}
 */
async function addTasks(tasks) {
    if (!Array.isArray(tasks)) {
        tasks = [tasks];
    }

    for (const task of tasks) {
        await knex.transaction(async tx => {
            const exists = await checkExistence(tx, task.name);
            if (!exists) {
                await addBuiltinTask(tx, task);
            } else {
                await updateBuiltinTask(tx, exists.id, task);
            }
        });
    }
}

/**
 * List all builtin tasks currently in the system
 * @return {Promise<any>}
 */
async function list() {
    const tasks = await knex('tasks').where({source: TaskSource.BUILTIN});
    tasks.forEach(task => task.settings = JSON.parse(task.settings));
    return tasks;
}

module.exports.list = list;
module.exports.storeBuiltinTasks = storeBuiltinTasks;
module.exports.getBuiltinTask = getBuiltinTask;
