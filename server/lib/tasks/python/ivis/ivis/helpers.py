import json
import os
import sys

from .exceptions import *

from elasticsearch import Elasticsearch


class Ivis:
    """Helper class for ivis tasks"""

    def __init__(self):
        self._data = json.loads(sys.stdin.readline())
        self._elasticsearch = Elasticsearch([{'host': self._data['es']['host'], 'port': int(self._data['es']['port'])}])
        self.state = self._data.get('state')
        self.parameters = self._data['params']
        self.entities = self._data['entities']
        self.owned = self._data['owned']

    @property
    def elasticsearch(self):
        return self._elasticsearch

    @staticmethod
    def _get_response_message():
        msg = json.loads(sys.stdin.readline())
        error = msg.get('error')
        if error:
            raise RequestException(error)
        return msg

    @staticmethod
    def _send_request_message(msg):
        os.write(3, (json.dumps(msg) + '\n').encode())

    @staticmethod
    def create_signals(signal_sets=None, signals=None):
        msg = {
            'type': 'create_signals',
        }

        if signal_sets is not None:
            msg['signalSets'] = signal_sets

        if signals is not None:
            msg['signals'] = signals

        Ivis._send_request_message(msg)
        return Ivis._get_response_message()

    @staticmethod
    def create_signal_set(cid, namespace, name=None, description=None, record_id_template=None, signals=None):

        signal_set = {
            "cid": cid,
            "namespace": namespace
        }

        if name is not None:
            signal_set["name"] = name
        if description is not None:
            signal_set["description"] = description
        if record_id_template is not None:
            signal_set["record_id_template"] = record_id_template
        if signals is not None:
            signal_set['signals'] = signals

        return Ivis.create_signals(signal_sets=signal_set)

    @staticmethod
    def create_signal(signal_set_cid, cid, namespace, type, name=None, description=None, indexed=None, settings=None,
                      weight_list=None, weight_edit=None, **extra_keys):

        # built-in type is shadowed here because this way we are able to call create_signal(set_cid, **signal),
        # where signal is dictionary with same structure as json that is accepted by REST API for signal creation

        signal = {
            "cid": cid,
            "type": type,
            "namespace": namespace,
        }

        if indexed is not None:
            signal["indexed"] = indexed
        if settings is not None:
            signal["settings"] = settings
        if weight_list is not None:
            signal["weight_list"] = weight_list
        if weight_edit is not None:
            signal["weight_edit"] = weight_edit
        if name is not None:
            signal["name"] = name
        if description is not None:
            signal["description"] = description

        signal.update(extra_keys)

        signals = {}
        signals[signal_set_cid]: signal

        return Ivis.create_signals(signals=signals)

    @staticmethod
    def store_state(state):
        msg = {
            "type": "store_state",
            "state": state
        }

        Ivis._send_request_message(msg)
        return Ivis._get_response_message()


ivis = Ivis()
