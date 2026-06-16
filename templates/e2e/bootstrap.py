#!/usr/bin/env python3
"""Bootstrap — auto-installs whatever's missing (selenium, pytest, etc.) then runs the suite.
No prerequisite beyond Python 3.10+ and a Chrome/Chromium binary.

Usage:
    python3 tests/bootstrap.py                  # full suite
    python3 tests/bootstrap.py -m smoke -v       # any pytest arg works, forwarded as-is
"""
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent   # project root (tests/ is one level down)
TESTS_DIR = Path(__file__).parent

REQUIRED_MODULES = {
    'selenium': 'selenium',
    'pytest': 'pytest',
    'pytest_html': 'pytest-html',
    'pytest_rerunfailures': 'pytest-rerunfailures',
    'xdist': 'pytest-xdist',
    'dotenv': 'python-dotenv',
    'faker': 'faker',
    'requests': 'requests',
    'axe_selenium_python': 'axe-selenium-python',
}


def _missing_packages() -> list[str]:
    return [pkg for mod, pkg in REQUIRED_MODULES.items() if importlib.util.find_spec(mod) is None]


def _pip_install(args: list[str]) -> None:
    print(f"[bootstrap] installing: {' '.join(args)}")
    subprocess.run([sys.executable, '-m', 'pip', 'install', *args], check=True)


def _ensure_dependencies() -> None:
    missing = _missing_packages()
    if not missing:
        return
    requirements = TESTS_DIR / 'requirements.txt'
    if requirements.exists():
        _pip_install(['-r', str(requirements)])
    else:
        _pip_install(missing)


def _check_browser() -> None:
    if shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser'):
        return
    print('[bootstrap] WARNING: no Chrome/Chromium binary found on PATH.')
    print('  Selenium 4.6+ auto-downloads the matching driver, but still needs an actual browser installed.')
    print('  Debian/Ubuntu : sudo apt install -y chromium-browser')
    print('  macOS         : brew install --cask google-chrome')
    print('  Windows       : winget install Google.Chrome')


def main() -> int:
    _ensure_dependencies()
    _check_browser()
    args = sys.argv[1:] or ['-v']
    return subprocess.run([sys.executable, '-m', 'pytest', *args], cwd=ROOT).returncode


if __name__ == '__main__':
    sys.exit(main())
