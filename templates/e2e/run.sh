#!/usr/bin/env bash
# Entry point — auto-installs missing deps then runs the suite. Forwards all args to pytest.
# Usage: ./tests/run.sh                 (full suite)
#        ./tests/run.sh -m smoke -v     (any pytest arg)
set -e
cd "$(dirname "$0")"
python3 bootstrap.py "$@"
