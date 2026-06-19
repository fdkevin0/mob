"""Ensure generated stubs (mob.v1.*) are importable as top-level packages.

Imported for its side effect by package modules and the server entrypoint.
"""

import os
import sys

_GEN = os.path.join(os.path.dirname(__file__), "gen")
if _GEN not in sys.path:
    sys.path.insert(0, _GEN)
