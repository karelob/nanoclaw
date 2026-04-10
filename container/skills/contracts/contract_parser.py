"""
Contract Parser — LLM-based extrakce strukturovaných dat ze smluv.
Vždy Ollama (citlivá data). Výsledky cachuje do ~/.cache/nanoclaw/contracts/.
Přírůstkový index — přeskakuje soubory beze změny (hash).
"""
import json
import hashlib
import sys
import datetime
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import SKILLS_DIR

# Import LLMClient ze sdíleného finance modulu
sys.path.insert(0, str(SKILLS_DIR / 'finance'))
from llm_client import LLMClient, FINANCE_SYSTEM_PROMPT

# Persistent cache (host i kontejner)
_HOME = Path.home()
CONTRACTS_CACHE = _HOME / '.cache/nanoclaw/contracts'


@dataclass
class ContractData:
    # Identita
    company: str            # baker | pinehill | ...
    counterparty: str       # druhá smluvní strana
    contract_type: str      # rental | loan | service | hr | vehicle | consulting | corporate | other

    # HR
    employment_type: str = ''   # HPP | DPP | DPČ | ''
    employee_name: str = ''

    # Finance
    payment_amount: float = 0.0
    payment_currency: str = 'CZK'
    payment_frequency: str = ''   # monthly | quarterly | annual | one-time | irregular | ''

    # Termíny
    start_date: str = ''
    end_date: str = ''            # '' = neurčito / neomezeno
    notice_period_days: int = 0   # výpovědní lhůta ve dnech

    # Obsah
    description: str = ''
    key_terms: list = field(default_factory=list)

    # Metadata
    source_file: str = ''
    source_category: str = ''
    file_hash: str = ''
    extracted_at: str = ''

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> 'ContractData':
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in known})


_EXTRACTION_PROMPT = """Analyzuj tento smluvní dokument a extrahuj strukturovaná data.

Dokument:
{text}

Vrať POUZE validní JSON (bez markdown bloků, bez komentářů):
{{
  "counterparty": "název druhé smluvní strany",
  "contract_type": "rental|loan|service|hr|vehicle|consulting|corporate|other",
  "employment_type": "HPP|DPP|DPČ|",
  "employee_name": "jméno zaměstnance/brigádníka nebo ''",
  "payment_amount": číslo nebo 0,
  "payment_currency": "CZK|EUR|USD",
  "payment_frequency": "monthly|quarterly|annual|one-time|irregular|",
  "start_date": "DD.MM.YYYY nebo YYYY nebo ''",
  "end_date": "DD.MM.YYYY nebo YYYY nebo '' pokud neurčito/neomezeno",
  "notice_period_days": počet_dnů nebo 0,
  "description": "1-2 věty co smlouva upravuje a jaký je hlavní závazek",
  "key_terms": ["důležitý termín nebo podmínka 1", "termín 2"]
}}

Typy smluv:
- rental = pronájem (kancelář, nemovitost, parking)
- loan = zápůjčka, úvěr, financování
- service = servisní, poradenské, IT, bezpečnostní a jiné služby
- hr = zaměstnanecká smlouva, DPP, DPČ
- vehicle = auto, leasing, financing vozidla
- consulting = poradenství, advisory, konzultace
- corporate = zakladatelské, VH usnesení, plné moci
- other = ostatní

Pokud informace v dokumentu není, použij prázdný string nebo 0."""


def _file_hash(path: Path) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def _extract_pdf_text(pdf_path: Path, max_chars: int = 4000) -> str:
    """Extrahuj text z PDF — prvních 5 stránek."""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            text = '\n'.join(
                p.extract_text() or ''
                for p in pdf.pages[:5]
            )
            return text[:max_chars]
    except Exception as e:
        return f'[chyba čtení PDF: {e}]'


def _extract_docx_text(path: Path, max_chars: int = 4000) -> str:
    """Extrahuj text z DOCX."""
    try:
        import zipfile
        import xml.etree.ElementTree as ET
        with zipfile.ZipFile(path) as z:
            with z.open('word/document.xml') as f:
                tree = ET.parse(f)
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        texts = [t.text or '' for t in tree.findall('.//w:t', ns)]
        return ' '.join(texts)[:max_chars]
    except Exception as e:
        return f'[chyba čtení DOCX: {e}]'


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == '.pdf':
        return _extract_pdf_text(path)
    elif ext in ('.docx', '.doc'):
        return _extract_docx_text(path)
    return ''


def extract_contract(
    path: Path,
    company: str,
    category: str,
    llm: LLMClient,
) -> Optional[ContractData]:
    """Extrahuj strukturovaná data ze smlouvy pomocí LLM."""
    text = extract_text(path)
    if len(text.strip()) < 80:
        return None  # nečitelné nebo prázdné

    prompt = _EXTRACTION_PROMPT.format(text=text)
    try:
        response = llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT).strip()
        # Odstraň markdown code fence pokud přítomno
        if response.startswith('```'):
            lines = response.split('\n')
            response = '\n'.join(lines[1:-1] if lines[-1] == '```' else lines[1:])
        data = json.loads(response)
    except Exception:
        return None

    return ContractData(
        company=company,
        counterparty=data.get('counterparty', ''),
        contract_type=data.get('contract_type', 'other'),
        employment_type=data.get('employment_type', ''),
        employee_name=data.get('employee_name', ''),
        payment_amount=float(data.get('payment_amount') or 0),
        payment_currency=data.get('payment_currency', 'CZK') or 'CZK',
        payment_frequency=data.get('payment_frequency', ''),
        start_date=data.get('start_date', ''),
        end_date=data.get('end_date', ''),
        notice_period_days=int(data.get('notice_period_days') or 0),
        description=data.get('description', ''),
        key_terms=data.get('key_terms', []),
        source_file=str(path),
        source_category=category,
        file_hash=_file_hash(path),
        extracted_at=datetime.datetime.now().isoformat(),
    )


# --- Index persistence ---

def index_path(company: str) -> Path:
    return CONTRACTS_CACHE / f'{company}_contracts.json'


def load_index(company: str) -> list[ContractData]:
    p = index_path(company)
    if not p.exists():
        return []
    try:
        with open(p, encoding='utf-8') as f:
            return [ContractData.from_dict(d) for d in json.load(f)]
    except Exception:
        return []


def save_index(company: str, contracts: list[ContractData]):
    CONTRACTS_CACHE.mkdir(parents=True, exist_ok=True)
    with open(index_path(company), 'w', encoding='utf-8') as f:
        json.dump([c.to_dict() for c in contracts], f, ensure_ascii=False, indent=2)


def _make_llm() -> LLMClient:
    """Gemini jako výchozí pro smlouvy (lepší porozumění dokumentům), Ollama jako fallback."""
    try:
        from paths import load_env_var
        load_env_var('GOOGLE_AI_API_KEY')
        return LLMClient(backend='gemini', model='gemini-2.5-flash')
    except Exception:
        pass
    return LLMClient(backend='ollama')


def build_index(
    company: str,
    force: bool = False,
    verbose: bool = False,
) -> tuple[list[ContractData], int, int]:
    """
    Prochází GDrive a indexuje smlouvy firmy.
    Přeskakuje soubory beze změny (porovnání hash).
    Vrací (contracts, new_count, skipped_count).
    """
    from gdrive_contracts import iter_contract_files

    llm = _make_llm()
    existing_by_hash = (
        {c.file_hash: c for c in load_index(company)}
        if not force else {}
    )

    contracts: list[ContractData] = []
    new_count = 0
    skipped_count = 0

    for path, category in iter_contract_files(company):
        try:
            fhash = _file_hash(path)
        except OSError:
            continue

        if fhash in existing_by_hash:
            contracts.append(existing_by_hash[fhash])
            skipped_count += 1
            if verbose:
                print(f'  ⏭ {path.name}', flush=True)
            continue

        if verbose:
            print(f'  🔍 {path.name}', flush=True)

        contract = extract_contract(path, company, category, llm)
        if contract:
            contracts.append(contract)
            new_count += 1
            if verbose:
                print(f'     → {contract.counterparty} [{contract.contract_type}]', flush=True)

    save_index(company, contracts)
    return contracts, new_count, skipped_count
