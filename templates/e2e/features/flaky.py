"""Flaky-test detection — tracks each test's pass/fail outcome across recent runs
and flags tests that contradict themselves (pass sometimes, fail other times).

Why: pytest-rerunfailures retries on failure and shows the final result as green —
the instability signal is thrown away. This keeps it visible as a 🎲 chip on the
report row and a hero alert, separate from "is the test red right now".

Storage: lightweight JSONL file (tests/.test-history.jsonl, gitignored), one JSON
object per run, rolling window of MAX_RUNS entries. Each object:
  {"timestamp": 1700000000.0, "results": {"tests/seo/test_seo.py::...": "passed", ...}}

Sequential runs only — under pytest-xdist (-n auto) each worker sees a disjoint
subset of tests and writing concurrently to the same file would race. History
accumulation is skipped there (not a silent failure — documented in README.md).
Tune: TEST_HISTORY_MAX_RUNS env var. Disable: TEST_FLAKY_DETECTION=0.
"""
import json
import os
import time

HISTORY_PATH = os.getenv('TEST_HISTORY_FILE', 'tests/.test-history.jsonl')
MAX_RUNS     = int(os.getenv('TEST_HISTORY_MAX_RUNS', '20'))
ENABLED      = os.getenv('TEST_FLAKY_DETECTION', '1') == '1'

_history_runs: list[dict]    = []   # loaded once at session start
_session_results: dict[str, str] = {}  # current run's outcomes, saved at session end


def load() -> None:
    """Called once at session start (pytest_sessionstart). Read-only, safe under xdist."""
    global _history_runs
    if not ENABLED or not os.path.exists(HISTORY_PATH):
        return
    try:
        with open(HISTORY_PATH, encoding='utf-8') as f:
            lines = f.readlines()[-MAX_RUNS:]
        _history_runs = [json.loads(line) for line in lines if line.strip()]
    except Exception:
        _history_runs = []


def record(test_id: str, outcome: str) -> None:
    """Called from conftest.pytest_runtest_makereport for every test."""
    _session_results[test_id] = outcome


def info(test_id: str) -> tuple[int, int] | None:
    """Returns (n_distinct_outcomes, n_runs_seen) across history, excluding current run.
    None = test has no history yet (first time seen, or history file was absent).
    """
    outcomes = [
        run['results'][test_id]
        for run in _history_runs
        if test_id in run.get('results', {})
    ]
    if not outcomes:
        return None
    return len(set(outcomes)), len(outcomes)


def save() -> None:
    """Called at session end (pytest_sessionfinish). Skipped under xdist workers."""
    if not ENABLED or not _session_results:
        return
    try:
        os.makedirs(os.path.dirname(HISTORY_PATH) or '.', exist_ok=True)
        existing = []
        if os.path.exists(HISTORY_PATH):
            with open(HISTORY_PATH, encoding='utf-8') as f:
                existing = f.readlines()
        new_line = json.dumps({'timestamp': time.time(), 'results': _session_results})
        kept = existing[-(MAX_RUNS - 1):] if MAX_RUNS > 1 else []
        with open(HISTORY_PATH, 'w', encoding='utf-8') as f:
            f.writelines(kept + [new_line + '\n'])
    except Exception:
        pass
