#!/usr/bin/env bash
# Make the PyPI xgboost wheel importable on macOS without Homebrew.
#
# The official wheel links against @rpath/libomp.dylib but only searches
# /opt/homebrew/opt/libomp/lib. scikit-learn's wheel bundles the same LLVM
# OpenMP runtime, so we add a loader-relative rpath pointing at it and
# re-sign the library (ad hoc). Idempotent; exits 0 either way because the
# backend falls back to scikit-learn automatically when xgboost cannot load.
#
# Usage: scripts/enable_xgboost_macos.sh [path/to/python]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${1:-$HERE/../.venv/bin/python}"

if "$PY" -c "import xgboost" >/dev/null 2>&1; then
  echo "xgboost imports fine ($("$PY" -c 'import xgboost; print(xgboost.__version__)'))"
  exit 0
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "xgboost does not import and this is not macOS; nothing to do here"
  exit 0
fi
SITE="$("$PY" -c "import sysconfig; print(sysconfig.get_paths()['purelib'])")"
LIB="$SITE/xgboost/lib/libxgboost.dylib"
OMP="$SITE/sklearn/.dylibs/libomp.dylib"
if [ ! -f "$LIB" ]; then echo "xgboost is not installed ($LIB missing)"; exit 0; fi
if [ ! -f "$OMP" ]; then
  echo "scikit-learn's bundled libomp not found ($OMP). Install scikit-learn, or run: brew install libomp"
  exit 0
fi
if ! otool -l "$LIB" | grep -q "@loader_path/../../sklearn/.dylibs"; then
  echo "adding rpath @loader_path/../../sklearn/.dylibs to libxgboost.dylib"
  install_name_tool -add_rpath "@loader_path/../../sklearn/.dylibs" "$LIB" || { echo "install_name_tool failed"; exit 0; }
  codesign --force --sign - "$LIB" >/dev/null 2>&1 || echo "codesign warning (continuing)"
fi
if "$PY" -c "import xgboost; print('xgboost', xgboost.__version__, 'imports OK')"; then
  exit 0
fi
echo "xgboost still fails to import; the backend will use the scikit-learn fallback (brew install libomp fixes it)"
exit 0
