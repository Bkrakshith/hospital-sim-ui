#!/usr/bin/env bash
# Local CA + server certificate for HTTPS/WSS on 8443 (see make_cert.py --help). No sudo.
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY=python3
exec "$PY" "$HERE/make_cert.py" "$@"
