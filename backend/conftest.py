import os
import sys

# Make the generated stubs (mob.v1.*) importable as top-level packages.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "mob_backend", "gen"))
