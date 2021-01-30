#!/bin/bash

set -e

hostType=centos8-minimal

SCRIPT_PATH=$(dirname $(realpath -s $0))
. $SCRIPT_PATH/functions

performInstallHttps "$#" "$1" "$2" "$3" "$4" false
