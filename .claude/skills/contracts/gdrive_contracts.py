"""
GDrive Contracts — navigace k smluvní dokumentaci v Business Docs.
Prochází celý strom Business Docs / {Firma} / a identifikuje relevantní dokumenty.
Read-only — žádná modifikace zdrojových dat.
"""
import sys
import unicodedata
from pathlib import Path
from typing import Iterator

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import SKILLS_DIR

_GDRIVE_BASE = Path.home() / 'Library/CloudStorage/GoogleDrive-karel@obluk.com/Shared drives/Business Docs'

# Company folder names in Business Docs
COMPANY_FOLDERS = {
    'baker':     'Baker estates',
    'pinehill':  'Pinehill',
    'pinehouse': 'PineHouse',
    'pineinvest':'PineInvest',
    'pineair':   'PineAir',
}

# Folder name fragments to skip (not relevant for contracts)
_SKIP_FRAGMENTS = {
    'datová schránka', 'handling', 'letadlové dokumenty', 'community-magazine',
    'mitsubishi heavy industries', 'saab sweden docs', 'systém technického deníku',
    'aircraft', 'marketing', 'markyza prodej', 'korespondence', 'bozp',
    'useful info', 'pasy', 'nerealizováno', 'weight', 'towbar', 'eac services',
    '.datovkadb', '__pycache__', 'portfolio pineinvest', 'pipeline inactive',
    'fotky', 'old marketing', 'prirucka', 'limitnik', 'maintenance', 'práce na letadle',
    'předpisy', 'systém technického',
}


def _nfc(name: str) -> str:
    return unicodedata.normalize('NFC', name)


def _should_skip(name: str) -> bool:
    n = _nfc(name).lower()
    for frag in _SKIP_FRAGMENTS:
        if frag in n:
            return True
    return False


def company_root(company: str) -> Path | None:
    folder_name = COMPANY_FOLDERS.get(company.lower())
    if not folder_name:
        return None
    p = _GDRIVE_BASE / folder_name
    return p if p.exists() else None


def iter_contract_files(
    company: str,
    extensions: set[str] = {'.pdf', '.docx', '.doc'},
) -> Iterator[tuple[Path, str]]:
    """
    Yields (file_path, category) pro všechny smluvně relevantní soubory firmy.
    category je odvozena z cesty v adresářové struktuře.
    """
    root = company_root(company)
    if not root:
        return

    def _walk(folder: Path, depth: int = 0) -> Iterator[tuple[Path, str]]:
        if depth > 6:
            return
        try:
            entries = sorted(folder.iterdir())
        except (PermissionError, OSError):
            return
        for entry in entries:
            if entry.is_dir():
                if not _should_skip(entry.name):
                    yield from _walk(entry, depth + 1)
            elif entry.is_file() and entry.suffix.lower() in extensions:
                rel_parts = [_nfc(p) for p in entry.relative_to(root).parts[:-1]]
                category = _infer_category(rel_parts)
                yield entry, category

    yield from _walk(root)


def _infer_category(path_parts: list[str]) -> str:
    """Odvoď kategorii smlouvy z cesty adresáře."""
    path_str = '/'.join(path_parts).lower()
    if 'personální' in path_str or 'mzdy' in path_str:
        return 'hr'
    if 'zápůjčky' in path_str or 'úvěr' in path_str or 'zapujcky' in path_str:
        return 'loan'
    if 'auta' in path_str:
        return 'vehicle'
    if 'konzultace' in path_str:
        return 'consulting'
    if 'smlouvy' in path_str or 'smlouva' in path_str:
        return 'contract'
    if 'společnost' in path_str or 'spolecnost' in path_str:
        return 'corporate'
    if 'finance' in path_str:
        return 'finance'
    return 'other'


def list_available_companies() -> list[str]:
    return [k for k, v in COMPANY_FOLDERS.items() if (_GDRIVE_BASE / v).exists()]


def count_files(company: str) -> dict[str, int]:
    """Vrátí počet souborů per kategorie (preview před indexací)."""
    counts: dict[str, int] = {}
    for _, category in iter_contract_files(company):
        counts[category] = counts.get(category, 0) + 1
    return counts
