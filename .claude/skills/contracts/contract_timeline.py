"""
Contract Timeline Agent — temporální analýza smluvních závazků.
Pro každou protistranu (= složku) sestaví chronologickou historii dokumentů,
odhadne aktuální stav (aktivní / expirovaná / nejasné) a navrhne záznam
do active_contracts.yaml ke schválení Karlem.

Zdroje: GDrive Business Docs + osobní iCloud dokumenty.

Výstup: knowledge/contracts/review_pending.yaml
Po Karlově revizi: knowledge/contracts/active_contracts.yaml
"""
import re
import sys
import datetime
import unicodedata
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
import yaml  # PyYAML

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import KNOWLEDGE, SKILLS_DIR

sys.path.insert(0, str(SKILLS_DIR / 'finance'))
from llm_client import LLMClient, FINANCE_SYSTEM_PROMPT

from gdrive_contracts import (
    iter_contract_files, iter_personal_files,
    COMPANY_FOLDERS, PERSONAL_SOURCES,
)
from contract_parser import extract_text

# Output paths
REVIEW_FILE = KNOWLEDGE / 'contracts' / 'review_pending.yaml'
ACTIVE_FILE = KNOWLEDGE / 'contracts' / 'active_contracts.yaml'

# Termination signal keywords in filenames
_TERMINATION_KEYWORDS = {
    'výpověď', 'vypoved', 'ukončení', 'ukonceni', 'zrušení', 'zruseni',
    'zánik', 'zanik', 'termination', 'cancellation', 'resignation',
}
_AMENDMENT_KEYWORDS = {
    'dodatek', 'amendment', 'addendum', 'změna', 'zmena', 'update',
    'annex', 'příloha',
}

TODAY = datetime.date.today()


@dataclass
class DocFile:
    path: Path
    date_hint: Optional[datetime.date]   # odvozeno z názvu nebo mtime
    is_termination: bool
    is_amendment: bool
    name_nfc: str


@dataclass
class ContractGroup:
    key: str                # unikátní ID skupiny (company/counterparty)
    company: str            # baker | pinehill | ... | personal
    counterparty: str       # název protistrany (název složky)
    source_folder: str      # relativní cesta k GDrive/iCloud
    category: str           # inferred category
    files: list[DocFile] = field(default_factory=list)


@dataclass
class TimelineProposal:
    group_key: str
    company: str
    counterparty: str
    source_folder: str
    category: str

    # Agent's assessment
    agent_status: str       # LIKELY_ACTIVE | LIKELY_EXPIRED | NEEDS_REVIEW
    agent_confidence: str   # HIGH | MEDIUM | LOW
    agent_reason: str
    agent_timeline: list[str]   # klíčové události chronologicky

    # Extracted terms (best-effort)
    amount: float = 0.0
    currency: str = 'CZK'
    frequency: str = ''
    start_date: str = ''
    end_date: str = ''
    notice_period_days: int = 0
    description: str = ''

    # Karel's review fields (filled in by Karel)
    karel_status: str = ''      # active | expired | modified | skip
    karel_note: str = ''
    karel_amount: float = 0.0
    karel_currency: str = ''


# --- Date extraction from filename ---

_DATE_PATTERNS = [
    re.compile(r'(\d{4})[_\-](\d{2})[_\-](\d{2})'),   # YYYY-MM-DD or YYYY_MM_DD
    re.compile(r'(\d{4})[_\-](\d{2})'),                 # YYYY-MM
    re.compile(r'(\d{2})[_\-](\d{4})'),                 # MM-YYYY or MM_YYYY
    re.compile(r'(\d{4})'),                              # just year
]


def _parse_date_from_name(name: str) -> Optional[datetime.date]:
    name_clean = unicodedata.normalize('NFC', name)
    for pat in _DATE_PATTERNS:
        m = pat.search(name_clean)
        if m:
            groups = m.groups()
            try:
                if len(groups) == 3:
                    return datetime.date(int(groups[0]), int(groups[1]), int(groups[2]))
                elif len(groups) == 2:
                    y, mo = int(groups[0]), int(groups[1])
                    if y > 2000 and 1 <= mo <= 12:
                        return datetime.date(y, mo, 1)
                    elif mo > 2000 and 1 <= y <= 12:
                        return datetime.date(mo, y, 1)
                elif len(groups) == 1:
                    y = int(groups[0])
                    if 2000 <= y <= 2035:
                        return datetime.date(y, 1, 1)
            except ValueError:
                continue
    return None


def _doc_file(path: Path) -> DocFile:
    name_nfc = unicodedata.normalize('NFC', path.name).lower()
    date_hint = _parse_date_from_name(name_nfc) or datetime.date.fromtimestamp(path.stat().st_mtime)
    is_term = any(kw in name_nfc for kw in _TERMINATION_KEYWORDS)
    is_amend = any(kw in name_nfc for kw in _AMENDMENT_KEYWORDS)
    return DocFile(path=path, date_hint=date_hint, is_termination=is_term,
                   is_amendment=is_amend, name_nfc=name_nfc)


# --- Grouping ---

def _collect_groups_company(company: str) -> dict[str, ContractGroup]:
    """Seskupí soubory firmy dle složky protistrany."""
    groups: dict[str, ContractGroup] = {}
    for path, category in iter_contract_files(company):
        # Counterparty = první smysluplná složka v cestě (skip 'Finance', 'Smlouvy ostatní'...)
        rel = path.relative_to(
            Path.home() / 'Library/CloudStorage/GoogleDrive-karel@obluk.com'
            / 'Shared drives/Business Docs' / _company_folder(company)
        )
        parts = [unicodedata.normalize('NFC', p) for p in rel.parts[:-1]]

        counterparty = _best_counterparty(parts)
        source = '/'.join(parts[:-1]) if len(parts) > 1 else parts[0] if parts else ''
        key = f"{company}/{counterparty}"

        if key not in groups:
            groups[key] = ContractGroup(
                key=key, company=company, counterparty=counterparty,
                source_folder=source, category=category,
            )
        groups[key].files.append(_doc_file(path))

    # Sort files chronologically within each group
    for g in groups.values():
        g.files.sort(key=lambda f: f.date_hint or datetime.date(2000, 1, 1))

    return groups


def _company_folder(company: str) -> str:
    return COMPANY_FOLDERS.get(company.lower(), company)


_GENERIC_FOLDER_NAMES = {
    'smlouvy ostatní', 'smlouvy personální', 'smlouvy', 'finance',
    'konzultace', 'auta', 'společnost', 'ostatní', 'archiv',
    'obluk karel - zápůjčky a úvěry', 'obluk karel - zápůjčky', 'obluk karel - zápůjčky, úvěr',
    'mzdy baker', 'mzdy pinehill', 'ukončené', 'pipeline archive',
}


def _best_counterparty(parts: list[str]) -> str:
    """Vybere nejlepší název protistrany z hierarchie složek."""
    for part in parts:
        if part.lower() not in _GENERIC_FOLDER_NAMES and len(part) > 2:
            return part
    return parts[-1] if parts else 'Neznámý'


def _collect_groups_personal() -> dict[str, ContractGroup]:
    """Seskupí osobní dokumenty dle složky."""
    groups: dict[str, ContractGroup] = {}
    for path, source_key, category in iter_personal_files():
        rel = path.relative_to(PERSONAL_SOURCES[source_key])
        parts = [unicodedata.normalize('NFC', p) for p in rel.parts[:-1]]
        counterparty = _best_counterparty(parts) if parts else source_key
        key = f"personal/{source_key}/{counterparty}"
        source = f"iCloud/{source_key}/" + '/'.join(parts[:-1])

        if key not in groups:
            groups[key] = ContractGroup(
                key=key, company='personal', counterparty=counterparty,
                source_folder=source, category=category,
            )
        groups[key].files.append(_doc_file(path))

    for g in groups.values():
        g.files.sort(key=lambda f: f.date_hint or datetime.date(2000, 1, 1))

    return groups


# --- LLM Analysis ---

_TIMELINE_PROMPT = """Analyzuješ skupinu dokumentů týkajících se jednoho smluvního vztahu.

Firma: {company}
Protistrana: {counterparty}
Kategorie: {category}
Složka: {source_folder}

Dokumenty v chronologickém pořadí:
{file_list}

Klíčové dokumenty (text):
{key_texts}

Odpověz POUZE v tomto YAML formátu (bez markdown):
agent_status: LIKELY_ACTIVE  # nebo LIKELY_EXPIRED nebo NEEDS_REVIEW
agent_confidence: HIGH  # nebo MEDIUM nebo LOW
agent_reason: "Stručné zdůvodnění (1-2 věty)"
agent_timeline:
  - "YYYY-MM: Popis události"
  - "YYYY-MM: ..."
amount: 0  # číselná částka nebo 0
currency: CZK  # nebo EUR nebo USD
frequency: monthly  # nebo quarterly, annual, one-time, nebo ''
start_date: ""  # YYYY-MM-DD nebo YYYY nebo ''
end_date: ""  # YYYY-MM-DD nebo YYYY nebo '' pokud neurčito
notice_period_days: 0
description: "1-2 věty co závazek upravuje a jaký je aktuální stav"

Pravidla pro odhad statusu:
- LIKELY_EXPIRED pokud: nalezen dokument s výpovědí/ukončením, nebo end_date < dnes, nebo jasně historické
- LIKELY_ACTIVE pokud: žádná výpověď, žádné datum ukončení, nebo datum ukončení v budoucnu
- NEEDS_REVIEW pokud: nejasné, protichůdné signály, nebo chybí klíčové informace"""


def _select_key_files(group: ContractGroup, max_files: int = 3) -> list[DocFile]:
    """Vybere klíčové soubory pro LLM analýzu (první, poslední, výpovědi, dodatky)."""
    selected = []
    files = group.files

    # Vždy přidej termination docs
    for f in files:
        if f.is_termination and len(selected) < max_files:
            selected.append(f)

    # Přidej nejnovější
    if files and files[-1] not in selected and len(selected) < max_files:
        selected.append(files[-1])

    # Přidej nejstarší (původní smlouva)
    if files and files[0] not in selected and len(selected) < max_files:
        selected.append(files[0])

    # Přidej amendment pokud místo
    for f in files:
        if f.is_amendment and f not in selected and len(selected) < max_files:
            selected.append(f)

    return sorted(selected, key=lambda f: f.date_hint or datetime.date(2000, 1, 1))


def analyze_group(group: ContractGroup, llm: LLMClient) -> Optional[TimelineProposal]:
    """LLM analýza skupiny dokumentů → TimelineProposal."""
    if not group.files:
        return None

    # File list pro LLM
    file_list_lines = []
    for f in group.files:
        date_str = f.date_hint.strftime('%Y-%m-%d') if f.date_hint else '?'
        flags = []
        if f.is_termination:
            flags.append('VÝPOVĚĎ')
        if f.is_amendment:
            flags.append('dodatek')
        flag_str = f" [{', '.join(flags)}]" if flags else ''
        file_list_lines.append(f"  {date_str}: {f.path.name}{flag_str}")

    # Extrakce textu z klíčových souborů
    key_files = _select_key_files(group)
    key_texts = []
    for f in key_files:
        text = extract_text(f.path)
        if text.strip():
            date_str = f.date_hint.strftime('%Y-%m') if f.date_hint else '?'
            key_texts.append(f"=== {f.path.name} [{date_str}] ===\n{text[:1500]}")

    if not key_texts:
        return None

    prompt = _TIMELINE_PROMPT.format(
        company=group.company,
        counterparty=group.counterparty,
        category=group.category,
        source_folder=group.source_folder,
        file_list='\n'.join(file_list_lines),
        key_texts='\n\n'.join(key_texts),
    )

    try:
        response = llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT).strip()
        # Strip markdown if present
        if response.startswith('```'):
            lines = response.split('\n')
            response = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
        data = yaml.safe_load(response)
        if not isinstance(data, dict):
            return None
    except Exception:
        return None

    return TimelineProposal(
        group_key=group.key,
        company=group.company,
        counterparty=group.counterparty,
        source_folder=group.source_folder,
        category=group.category,
        agent_status=data.get('agent_status', 'NEEDS_REVIEW'),
        agent_confidence=data.get('agent_confidence', 'LOW'),
        agent_reason=data.get('agent_reason', ''),
        agent_timeline=data.get('agent_timeline', []),
        amount=float(data.get('amount') or 0),
        currency=data.get('currency', 'CZK') or 'CZK',
        frequency=data.get('frequency', '') or '',
        start_date=str(data.get('start_date', '') or ''),
        end_date=str(data.get('end_date', '') or ''),
        notice_period_days=int(data.get('notice_period_days') or 0),
        description=data.get('description', ''),
    )


# --- Main review runner ---

def run_review(
    companies: list[str] | None = None,
    include_personal: bool = True,
    force: bool = False,
    verbose: bool = True,
) -> Path:
    """
    Projde všechny protistrany, analyzuje timeline, uloží review_pending.yaml.
    companies: None = všechny firmy. ['pinehill'] = jen Pinehill.
    """
    llm = LLMClient(backend='gemini', model='gemini-2.5-flash')

    all_groups: dict[str, ContractGroup] = {}

    # GDrive firmy
    target_companies = companies or list(COMPANY_FOLDERS.keys())
    for company in target_companies:
        if verbose:
            print(f"  Skenuji {company}...", flush=True)
        all_groups.update(_collect_groups_company(company))

    # Osobní dokumenty
    if include_personal:
        if verbose:
            print("  Skenuji osobní dokumenty...", flush=True)
        all_groups.update(_collect_groups_personal())

    if verbose:
        print(f"  Nalezeno {len(all_groups)} skupin protistrany.", flush=True)

    # Načti existující review (přeskočit již zpracované pokud ne force)
    existing_keys: set[str] = set()
    if REVIEW_FILE.exists() and not force:
        try:
            existing = yaml.safe_load(REVIEW_FILE.read_text(encoding='utf-8')) or []
            existing_keys = {e.get('group_key', '') for e in existing if isinstance(e, dict)}
        except Exception:
            pass

    proposals: list[dict] = []

    # Načti existující záznamy (přidáme nové k nim)
    if REVIEW_FILE.exists() and not force:
        try:
            old = yaml.safe_load(REVIEW_FILE.read_text(encoding='utf-8')) or []
            proposals.extend([e for e in old if isinstance(e, dict)])
        except Exception:
            pass

    new_count = 0
    for key, group in sorted(all_groups.items()):
        if key in existing_keys and not force:
            continue

        if verbose:
            print(f"  → {key} ({len(group.files)} souborů)", flush=True)

        proposal = analyze_group(group, llm)
        if proposal is None:
            continue

        new_count += 1
        proposals.append(_proposal_to_dict(proposal))

        # Průběžně ukládej (ochrana proti přerušení)
        _save_yaml(proposals)

    if verbose:
        print(f"\n✅ {new_count} nových návrhů. Soubor: {REVIEW_FILE}", flush=True)

    return REVIEW_FILE


def _proposal_to_dict(p: TimelineProposal) -> dict:
    return {
        'group_key': p.group_key,
        'company': p.company,
        'counterparty': p.counterparty,
        'source_folder': p.source_folder,
        'category': p.category,
        # Agent assessment
        'agent_status': p.agent_status,
        'agent_confidence': p.agent_confidence,
        'agent_reason': p.agent_reason,
        'agent_timeline': p.agent_timeline,
        # Extracted terms
        'amount': p.amount,
        'currency': p.currency,
        'frequency': p.frequency,
        'start_date': p.start_date,
        'end_date': p.end_date,
        'notice_period_days': p.notice_period_days,
        'description': p.description,
        # Karel's review (empty — to be filled)
        'Karel_status': None,   # active | expired | modified | skip
        'Karel_note': '',
        'Karel_amount': None,
        'Karel_currency': None,
    }


def _save_yaml(proposals: list[dict]):
    REVIEW_FILE.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Temporal contract review — vygenerováno agentem\n"
        "# Karel_status: active | expired | modified | skip\n"
        "# Vyplň Karel_status pro každý záznam a spusť /contracts promote\n\n"
    )
    REVIEW_FILE.write_text(
        header + yaml.dump(proposals, allow_unicode=True, default_flow_style=False,
                           sort_keys=False, width=120),
        encoding='utf-8',
    )


def promote_confirmed() -> tuple[int, int]:
    """
    Přesune záznamy s Karel_status='active'|'modified' do active_contracts.yaml.
    Vrací (promoted_count, remaining_count).
    """
    if not REVIEW_FILE.exists():
        return 0, 0

    pending = yaml.safe_load(REVIEW_FILE.read_text(encoding='utf-8')) or []
    active = yaml.safe_load(ACTIVE_FILE.read_text(encoding='utf-8')) if ACTIVE_FILE.exists() else []
    active = active or []

    promoted = 0
    remaining = []

    for entry in pending:
        if not isinstance(entry, dict):
            continue
        status = (entry.get('Karel_status') or '').strip().lower()
        if status in ('active', 'modified'):
            # Build clean active_contracts entry
            amt = entry.get('Karel_amount') or entry.get('amount', 0)
            cur = entry.get('Karel_currency') or entry.get('currency', 'CZK')
            active.append({
                'company': entry['company'],
                'counterparty': entry['counterparty'],
                'type': entry['category'],
                'amount': amt,
                'currency': cur,
                'frequency': entry.get('frequency', ''),
                'end_date': entry.get('end_date', ''),
                'notice_period_days': entry.get('notice_period_days', 0),
                'description': entry.get('description', ''),
                'source_folder': entry.get('source_folder', ''),
                'note': entry.get('Karel_note', ''),
            })
            promoted += 1
        elif status not in ('expired', 'skip'):
            remaining.append(entry)

    ACTIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_FILE.write_text(
        "# Active contracts — confirmed by Karel\n\n"
        + yaml.dump(active, allow_unicode=True, default_flow_style=False,
                    sort_keys=False, width=120),
        encoding='utf-8',
    )

    _save_yaml(remaining)
    return promoted, len(remaining)


if __name__ == '__main__':
    import sys as _sys
    args = _sys.argv[1:]
    if args and args[0] == 'promote':
        p, r = promote_confirmed()
        print(f"✅ Promoted: {p} | Remaining: {r}")
    else:
        companies = [a for a in args if a in COMPANY_FOLDERS] or None
        personal = '--no-personal' not in args
        force = '--force' in args
        run_review(companies=companies, include_personal=personal, force=force)
