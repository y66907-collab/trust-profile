"""Reruns the engine on what a live-lab round collected, in seconds and without touching Gmail.

Reads the payload JSON from stdin and writes the engine's JSON to stdout. Nothing is written to disk.
Usage: curl -H "x-code: <code>" http://127.0.0.1:<port>/admin/payload | python engine_rerun.py
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "engine"))
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

import pilot  # noqa: E402

print(pilot.run(sys.stdin.read()))
