'use strict';
import {TaskType, subtypesByType} from "../../../../shared/tasks";

const WizardType = {
    BLANK: 'blank',
    BASIC: 'basic',
    ENERGY_PLUS: 'energy_plus',
    MOVING_AVERAGE: 'moving_average',
    AGGREGATION: 'aggregation',
    MODEL_COMPARISON: 'model_comparison'
};

if (Object.freeze) {
    Object.freeze(WizardType)
}

// BLANK
const blank = {
    label: 'Blank',
    wizard: (data) => {
        data.settings = {
            params: [],
            code: ''
        };
    }
};

// BASIC
function apiShowcaseFn(data) {
    data.settings = {
        params:
            [
                {
                    "id": "sigSet",
                    "help": "Signal set showcase",
                    "type": "signalSet",
                    "label": "Signal Set"
                },
                {
                    "id": "value",
                    "help": "showcase value",
                    "type": "string",
                    "label": "value"
                },
                {
                    "id": "value",
                    "label": "value",
                    "type": "signal",
                    "signalSetRef": "sigSet"
                },
                {
                    "id": "ts",
                    "label": "ts",
                    "type": "signal",
                    "signalSetRef": "sigSet"
                }
            ],
        code:
            `
import json
from ivis import ivis 

es = ivis.elasticsearch
state = ivis.state

params= ivis.parameters
entities= ivis.entities

sigSet = params['sigSet']
value_sig = params['value']
ts_sig = params['ts']

#print('State:')
#print(json.dumps(state, indent=2))
#print()

#print('Params:')
#print(json.dumps(params, indent=2))
#print()

#print('Entities:')
#print(json.dumps(entities, indent=2))
#print()


if state is None or state.get('api_set') is None:
  ns = entities['signalSets'][sigSet]['namespace']

  # Request new signal set creation 

  signals= []
  signals.append({
    "cid": "api_signal",
    "name": "showcase signal",
   "description": "api showcase signal",
   "namespace": ns,
    "type": "text",
    "indexed": False,
    "settings": {}
  })

  state = ivis.create_signal_set("api_set",ns,"API test", "API test", None, signals)
    
  ivis.store_state(state)

# FILES
with open('../files/test.txt', 'r') as file: 
  lines = file.readlines()
  value = lines[0].strip()
  print('File:')
  print(value)
  print()

# Elasticsearch reading
val_field = entities['signals'][sigSet][value_sig]['field']
ts_field = entities['signals'][sigSet][ts_sig]['field']

query = {
   'size': 1,
   '_source': val_field,
   'sort': [{ts_field: 'desc'}],
   'query': {
      "match_all": {}
   }
}

index = entities['signalSets'][sigSet]['index']
results = es.search(index=index, body=query)
value = results['hits']['hits'][0]['_source'][val_field] if results['hits']['total'] > 0 else 'not found'

print('ES reading:')
print(value)
print()

# Elasticsearch indexing
doc = {
  state['api_set']['fields']['api_signal']: value
}
res = es.index(index=state['api_set']['index'], doc_type='_doc', body=doc)

ivis.store_state(state)
`
    };
}

const apiShowcase = {
    label: 'Api Showcase',
    wizard: apiShowcaseFn
};

// ENERGY_PLUS

function energyPlusFn(data) {
    data.settings = {
        params: [
            {
                "id": "mod",
                "help": "mod",
                "type": "string",
                "label": "mod"
            },
            {
                "id": "occ",
                "help": "occ",
                "type": "string",
                "label": "occ"
            }
        ],
        code: `
import json
from datetime import datetime, timedelta
from ivis import ivis 
from elasticsearch import helpers

import requests
import subprocess
import pathlib
    
from eppy import modeleditor
from eppy.modeleditor import IDF
idd_file = "/usr/local/Energy+.idd"
IDF.setiddname(idd_file)

from io import StringIO

es = ivis.elasticsearch
state = ivis.state
params= ivis.parameters
entities= ivis.entities

if state is None:
  state= {}

# BODY ==================================================================
api_url_base = 'https://example.com/api'
api_url_login = f'{api_url_base}/login'
api_url_file = f'{api_url_base}/meteo-file'

occ = params['occ']
mod = params['mod']

username = 'username'
password = 'password'
 
current_date = datetime.now()

# Get access token 
login_result = requests.post(api_url_login, data = {'username':username, 'password': password})
acc_info = login_result.json()

acc_key = acc_info['accessKey']
key_param = f'access_key={acc_key}'

# Get weather file
url_epw = api_url_epw_file = f'{api_url_file}?{key_param}&action=epw'
epw_result = requests.get(url_epw, timeout=90)

if epw_result.status_code != 200 :
  sys.stderr.write(f"Weather file couldn't be downloaded, code {epw_result.status_code}")
  exit(1)

model_dir = f'occ{occ}_mod{mod}'
os.makedirs(f'{model_dir}', exist_ok=True)
with open(f'{model_dir}/weather.epw', 'wb') as f:
  f.write(epw_result.content)

if state is None or state.get(f'energy_plus_{mod}_{occ}') is None:
  ns = 1

  signals= []
  signals.append({
    "cid": "date",
    "name": "date",
   "description": "date and time",
   "namespace": ns,
    "type": "date",
    "indexed": False,
    "settings": {}
  })
  signals.append({
    "cid": "temperature",
    "name": "temperature",
    "description": "Mean Air Temperature [C]",
    "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  signals.append({
    "cid": "humidity",
    "name": "humidity",
   "description": "Air Relative Humidity [%]",
   "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  signals.append({
    "cid": "co2",
    "name": "co2",
   "description": "Air CO2 Concentration [ppm]",
   "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  
  state = ivis.create_signal_set(f"energy_plus_{mod}_{occ}",ns,f"EnergyPlus mod{mod} occ{occ}", f"EnergyPlus calculation for mod {mod} and occ {occ}" , None, signals)
    
  ivis.store_state(state)

  
else: 
  #clean up before calculation
  es.delete_by_query(index=state[f'energy_plus_{mod}_{occ}']['index'],request_timeout=60,body={"query" :{
    "match_all": {}
  }})

# Get IDF file
url = f'{api_url_file}?{key_param}&action=idf&occ={occ}&mod={mod}'
idf_result = requests.get(url, timeout=90)

if idf_result.status_code != 200 :
  sys.stderr.write(f"IDF file couldn't be downloaded, code {idf_result.status_code}")
  exit(1)

# Edit idf file date
idf = IDF(StringIO(idf_result.text))
period =  idf.idfobjects["RunPeriod"][0]

from_date = current_date - timedelta(days=3)
period.Begin_Day_of_Month =   from_date.day
period.Begin_Month =   from_date.month
period.Begin_Year =   from_date.year

to_date = current_date + timedelta(days=1)
period.End_Day_of_Month =  to_date.day
period.End_Month =  to_date.month
period.End_Year = to_date.year

# Save to file
idf.saveas(f'{model_dir}/input.idf')
subprocess.run(['/usr/local/energyplus', '-w', r'weather.epw', 'input.idf'],cwd=f'{model_dir}')

# Generator for computed values
def iterResults():
  if not pathlib.Path(f'{model_dir}/eplusout.eso').exists():
    sys.stderr.write(f"File eplusout.eso not found.")
    exit(1)
    
  with open(f'{model_dir}/eplusout.eso', 'r') as f:
    # Skip dictionary segment
    while True:
      line = f.readline()
      if not line:
        sys.stderr.write(f"File eplusout.eso is not in corrrect format.")
        exit(1)
      else:
        line=line.strip()
      
      if line=='End of Data Dictionary':
        break;
        
    # Get values
    doc_source=None
    date=None
    time_zone = 0
    while True:
      line = f.readline()
      
      if not line:
        break
      
      line=line.strip()
      if line=='End of Data':
        break;
      
      line_data = line.split(',')
      if line_data[0]=='1':
        # TODO check might be float?
        time_zone = float(line_data[4].strip())
        
      elif line_data[0]=='2':
         # new data block

        if doc_source is not None:
          yield {
            "_index": state['energy_plus_{mod}_{occ}']['index'],
            "_type": '_doc',
            "_id":  date,
            "_source": doc_source
          }

          
        ## VALUES IN ORDER
        #Day of Simulation[]
        month= '{:02d}'.format(int(line_data[2]))#Month[]
        day = '{:02d}'.format(int(line_data[3])) #Day of Month[]
        tz_dst = time_zone + int(line_data[4]) #DST Indicator[1=yes 0=no]
        hour='{:02d}'.format(int(line_data[5])-1)#Hour[]  #-1 is here because for some reason (DST?) hours start on 1 not 0 
        start_min=line_data[6]#StartMinute[]
        end_min=line_data[7]#EndMinute[]
        #DayType
        
        #custom values
        min = '{:02d}'.format(int((float(start_min) + float(end_min)) / 2)) # TODO separate seconds
        # FIXME this should take the value somewhere from input, don't know where currently
        year = current_date.year
        
        sign = "+" if tz_dst >= 0 else "-"
        tz = '{:02d}'.format(int(tz_dst))
        date=f'{year}-{month}-{day}T{hour}:{min}:00.000{sign}{tz}:00'
        doc_source = {
          state['fields']['date']: date
        }
         
      elif line_data[0]=='118': #Temperature
        doc_source[state[f'energy_plus_{mod}_{occ}']['fields']['temperature']]= line_data[1]
      elif line_data[0]=='205': #Humidity
        doc_source[state[f'energy_plus_{mod}_{occ}']['fields']['humidity']]= line_data[1]
      elif line_data[0]=='206': #CO2
        doc_source[state[f'energy_plus_{mod}_{occ}']['fields']['co2']]= line_data[1]

helpers.bulk(es, iterResults())

os.close(3)        
`
    };
}

const energyPlus = {
    label: 'Energy plus example',
    wizard: energyPlusFn
};


// MOVING_AVERAGE

function movingAvarageFn(data) {
    data.settings = {
        params: [
            {
                "id": "sigSet",
                "help": "Signal set for the sensors",
                "type": "signalSet",
                "label": "Signal Set"
            },
            {
                "id": "ts",
                "help": "Timestamp order is based on",
                "type": "signal",
                "label": "Timestamp",
                "cardinality": "1",
                "signalSetRef": "sigSet"
            },
            {
                "id": "source",
                "help": "Source of values",
                "type": "signal",
                "label": "Source of value",
                "cardinality": "1",
                "signalSetRef": "sigSet"
            },
            {
                "id": "window",
                "help": "Mean window",
                "type": "number",
                "label": "Mean window"
            }
        ],
        code: `
from ivis import ivis
from collections import deque
from elasticsearch import helpers

es = ivis.elasticsearch
state = ivis.state
params= ivis.parameters
entities= ivis.entities

# Task parameters' values
# from params we get cid of signal/signal set and from according key in entities dictionary 
# we can access data for that entity (like es index or namespace)
sig_set = entities['signalSets'][params['sigSet']]
ts = entities['signals'][params['sigSet']][params['ts']]
source = entities['signals'][params['sigSet']][params['source']]
window = int(params['window'])

values = []
if state is not None:
  values = state.get("values") if state.get("values") else []
queue = deque(values, maxlen=window)

if state is None or state.get('moving_average') is None:
  ns = sig_set['namespace']

  signals= [] 
  signals.append({
    "cid": "mean",
    "name": "mean",
    "description": "mean",
    "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  
  state = ivis.create_signal_set("moving_average",ns,"moving average", "moving average", None, signals)
    
  ivis.store_state(state)
    
last = None
if state is not None and state.get('last') is not None:
  last = state['last']
  query_content = {
    "range" : {
      ts['field'] : {
        "gt" : last
      }
    }
  }
else:
  query_content = {'match_all': {}}


query = {
    'size': 10000,
    '_source': [source['field'], ts['field']],
    'sort': [{ts['field']: 'asc'}],
    'query': query_content
}

results = helpers.scan(es,
                       preserve_order=True,
                       query=query,
                       index=sig_set['index']
                       )

i = 0
for item in results:
  last = item["_source"][ts['field']]
  val = item["_source"][source['field']]
  if val is not None:
    queue.append(val)
  else:
    continue
  if i < (window-1):
    i += 1
  else:
    mean = sum(queue) / float(window)
    doc = {
      state['moving_average']['fields']['mean']: mean 
    }
    res = es.index(index=state['moving_average']['index'], doc_type='_doc', body=doc)

state["last"] = last
state["values"] = list(queue)
ivis.store_state(state)
        `
    };
}

const movingAvarage = {
    label: 'Moving average example',
    wizard: movingAvarageFn
};

// AGGREGATION
function aggregationFn(data) {
    data.settings = {
        params: [
            {
                "id": "sigSet",
                "help": "Signal set for the sensors",
                "type": "signalSet",
                "label": "Signal Set"
            },
            {
                "id": "ts",
                "help": "Timestamp aggregation is based on",
                "type": "signal",
                "label": "Timestamp",
                "cardinality": "1",
                "signalSetRef": "sigSet"
            },
            {
                "id": "source",
                "help": "Source of values",
                "type": "signal",
                "label": "Source of value",
                "cardinality": "1",
                "signalSetRef": "sigSet"
            },
            {
                "id": "interval",
                "help": "interval in minutes",
                "type": "number",
                "label": "Interval in minutes"
            }
        ],
        code: `
from ivis import ivis

es = ivis.elasticsearch
state = ivis.state

params= ivis.parameters
entities= ivis.entities

sig_set = entities['signalSets'][params['sigSet']]
ts = entities['signals'][params['sigSet']][params['ts']]
source = entities['signals'][params['sigSet']][params['source']]
interval = params['interval']

if state is None or state.get('aggs') is None:
  ns = sig_set['namespace']

  signals= []
  signals.append({
    "cid": "ts",
    "name": "Timestamp",
    "description": "Interval timestamp",
    "namespace": ns,
    "type": "date",
    "indexed": False,
    "settings": {}
  })
  signals.append({
    "cid": "min",
    "name": "min",
    "description": "min",
    "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
    signals.append({
    "cid": "avg",
    "name": "avg",
    "description": "avg",
    "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  signals.append({
    "cid": "max",
    "name": "max",
    "description": "max",
    "namespace": ns,
    "type": "double",
    "indexed": False,
    "settings": {}
  })
  
  state = ivis.create_signal_set("aggs",ns,"aggregation", "aggregation", None, signals)
    
  ivis.store_state(state)

last = None
if state is not None and state.get('last') is not None:
  last = state['last']
  query_content = {
    "range" : {
      ts['field'] : {
        "gte" : last
      }
    }
  }
  
  es.delete_by_query(index=state['aggs']['index'], body={
    "query": { 
      "match": {
        state['aggs']['fields']['ts']: last
      }
    }}
  )
  
else:
  query_content = {'match_all': {}}

query = {
  'size': 0,
  'query': query_content,
  "aggs": {
    "stats": {
      "date_histogram": {
        "field": ts['field'],
        "interval": interval+"m"
      },
      "aggs": {
        "avg": {
          "avg": {
            "field": source['field']
          }
        },
        "max": {
          "max" : {
            "field": source['field']
          }
        },
        "min": {
          "min" : {
            "field": source['field']
          }
        }
      }
    }
  }
}

res = es.search(index=sig_set['index'], body=query)

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
    };
}

const aggregation = {
    label: 'Aggregation example',
    wizard: aggregationFn
};

// MODEL COMPARISON
function modelComparisonFn(data) {
    data.settings = {
        params: [
            {
                "id": "sensors",
                "label": "Sensor data",
                "type": "signalSet"
            },
            {
                "id": "source",
                "label": "Value to compare on",
                "type": "signal",
                "signalSetRef": "sensors"
            },
            {
                "id": "ts",
                "label": "ts",
                "type": "signal",
                "signalSetRef": "sensors"
            },
            {
                "id": "models",
                "label": "Models",
                "type": "fieldset",
                "cardinality": "1..n",
                "children": [
                    {
                        "id": "sigSet",
                        "label": "Signal Set",
                        "type": "signalSet"
                    },
                    {
                        "id": "source",
                        "label": "Value to compare on",
                        "type": "signal",
                        "signalSetRef": "sigSet"
                    },
                    {
                        "id": "ts",
                        "label": "ts",
                        "type": "signal",
                        "signalSetRef": "sigSet"
                    }
                ]
            }
        ],
        code: ` 
from ivis import ivis 

from datetime import datetime, timezone
import numpy as np
from dtw import dtw

es = ivis.elasticsearch
state = ivis.state
params= ivis.parameters
entities= ivis.entities

# Get ES index and fields
sensor_set = entities['signalSets'][params['sensors']]
sensor_ts = entities['signals'][params['sensors']][params['ts']]
sensor_source = entities['signals'][params['sensors']][params['source']]

limit_val = float(params['limitValue'])

limit = limit_val

if state is None or state.get('models_comparison') is None:
    ns = sensor_set['namespace']

    signals= [] 
    signals.append({
      "cid": "ts",
      "name": "ts",
      "description": "timestamp",
      "namespace": ns,
      "type": "date",
      "indexed": False,
      "settings": {}
    })
    signals.append({
      "cid": "model",
      "name": "model",
      "description": "Closest model's cid",
      "namespace": ns,
      "type": "keyword",
      "indexed": False,
      "settings": {}
    })
    
  state = ivis.create_signal_set("models_comparison",ns,"Comparison of models", "Comparison of models", None, signals)
    
  ivis.store_state(state)

def get_source_values(index,ts_field, source_field):
  # sensor data query
  query = {
      '_source': [source_field, ts_field],
      'sort': [{ts_field: 'asc'}],
      'query': {
        "range" : {
          ts_field : {
            "gt" : "now-180m/m",
            "lt" : "now/m"
          }
        }
      }
  }
  
  results = es.search(index=index, body=query)
  
  sensor_data = []
  for item in results['hits']['hits']:
    val = item["_source"][source_field]
    if val is not None:
      sensor_data.append(val)
    else:
      continue
  
  return sensor_data

sensor_data = get_source_values(sensor_set['index'], sensor_ts['field'], sensor_source['field'])

if not sensor_data:
  print('No sensor data to measure on')
  exit()

sensor_np = np.array(sensor_data, dtype=float).reshape(-1, 1)

euclidean_norm = lambda x, y: np.abs(x - y)

min_model={}
min_distance=float("inf")
for model in params['models']:
  
  ts =entities['signals'][model['sigSet']][model['ts']]['field']
  source =entities['signals'][model['sigSet']][model['source']]['field']
  sig_set = entities['signalSets'][model['sigSet']]['index']
  
  model_data = get_source_values(sig_set, ts,source)
  if not model_data:
    print(f'No data for signal set {sig_set}')
    continue
  # Calculate for all models
  model_np = np.array(model_data, dtype=float).reshape(-1, 1)
  
  # Calculate for all models
  d, cost_matrix, acc_cost_matrix, path = dtw(sensor_np, model_np, dist=euclidean_norm)
  
  if d<min_distance:
    min_distance = d
    min_model['name'] = entities["signalSets"][model["sigSet"]]["name"]
    min_model['cid'] = model["sigSet"]
    min_model['ts'] = ts
    min_model['source'] =source 
    min_model['index'] = sig_set

# Do something with closest model
if not min_model:
  print('No model found')
  exit()
print(f'Closest model is: {min_model["name"]}')

ts = datetime.now(timezone.utc).astimezone()
doc = {
  state['models_comparison']['fields']['ts']: ts,
  state['models_comparison']['fields']['model']: min_model['cid'],
}
res = es.index(index=state['models_comparison']['index'], doc_type='_doc', id=ts, body=doc)
`
    };
}

const modelComparison = {
    label: 'Model comparison example',
    wizard: modelComparisonFn
};

const wizardSpecs = {};

const defaultPythonWizards = {
    [WizardType.BLANK]: blank,
    [WizardType.BASIC]: apiShowcase,
    [WizardType.MOVING_AVERAGE]: movingAvarage,
    [WizardType.AGGREGATION]: aggregation
};

const numpyWizardSpecs = {
    wizards: {
        ...defaultPythonWizards,
        [WizardType.MODEL_COMPARISON]: modelComparison
    }
};

const energyPlusWizardSpecs = {
    wizards: {
        ...defaultPythonWizards,
        [WizardType.ENERGY_PLUS]: energyPlus
    }
};

wizardSpecs[TaskType.PYTHON] = {
    wizards: defaultPythonWizards,
    subtypes: {
        [subtypesByType[TaskType.PYTHON].ENERGY_PLUS]: numpyWizardSpecs,
        [subtypesByType[TaskType.PYTHON].NUMPY]: energyPlusWizardSpecs,

    }
};

if (Object.freeze) {
    Object.freeze(wizardSpecs);
}

function getWizardsForType(taskType, subtype = null) {
    const specsForType = wizardSpecs[taskType];

    if (!specsForType) {
        return null;
    }

    if (subtype) {
        if (!specsForType.subtypes){
           return null;
        }

        return specsForType.subtypes[subtype] ? specsForType.subtypes[subtype].wizards : null;
    } else {
        return specsForType.wizards;
    }
}

function getWizard(taskType, subtype, wizardType) {
    const wizardsForType = getWizardsForType(taskType, subtype);
    return wizardsForType ? wizardsForType[wizardType] : null;
}

export {
    WizardType,
    getWizard,
    getWizardsForType
};
