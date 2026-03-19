"""
Shared path resolution for NanoClaw skills.
Auto-detects environment (container vs host) and resolves paths accordingly.

Usage:
    from paths import CONE_DB, CONE_CONFIG, CONE_SCRIPTS, KNOWLEDGE, CACHE_DIR
"""
import os
from pathlib import Path

_home = Path(os.environ.get('HOME', str(Path.home())))
_in_container = Path('/workspace/group').exists()

# cone.db — SQLite database
if Path('/workspace/local-db/cone.db').exists():
    CONE_DB = Path('/workspace/local-db/cone.db')
elif Path('/workspace/extra/cone-db/cone.db').exists():
    CONE_DB = Path('/workspace/extra/cone-db/cone.db')
else:
    CONE_DB = _home / 'Develop/nano-cone/cone/db/cone.db'

# Config directory (token.json, .env)
if _in_container:
    CONE_CONFIG = Path('/workspace/extra/cone-config')
else:
    CONE_CONFIG = _home / 'Develop/nano-cone/cone/config'

TOKEN_FILE = CONE_CONFIG / 'token.json'
ENV_FILE = CONE_CONFIG / '.env'

# Cone Python scripts (connectors etc.)
if _in_container:
    CONE_SCRIPTS = Path('/workspace/extra/cone-scripts')
else:
    CONE_SCRIPTS = _home / 'Develop/nano-cone/cone/scripts'

# Knowledge repo
if _in_container:
    KNOWLEDGE = Path('/workspace/extra/knowledge')
else:
    KNOWLEDGE = _home / 'Develop/nano-cone/knowledge'

# Cache for downloaded files
CACHE_DIR = Path('/tmp/finance_cache')

# Skills directory (for resolving sibling skills)
if _in_container:
    SKILLS_DIR = Path('/home/node/.claude/skills')
else:
    # Find skills dir relative to this file
    SKILLS_DIR = Path(__file__).parent


def load_env_var(key: str) -> str:
    """Load a variable from process env or .env file."""
    val = os.environ.get(key)
    if val:
        return val
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(f'{key}='):
                return line.split('=', 1)[1].strip()
    raise RuntimeError(f'{key} not found in environment or {ENV_FILE}')


def ensure_cone_scripts_importable():
    """Add cone scripts to sys.path so connectors can be imported."""
    import sys
    scripts_str = str(CONE_SCRIPTS)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
