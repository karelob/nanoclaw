"""
Cashflow projekce — behaviorální analýza platebních vzorců.
Analyzuje historii bankovních výpisů, identifikuje:
  - Smluvní závazky (z contracts indexu)
  - Pravidelné vzorce detekované z opakování v historii
  - Jednorázové platby
  - Intra-group toky (daňová optimalizace, ad hoc, neprojektovat)
Projektuje cashflow 3 měsíce dopředu.
Vždy Ollama — citlivá data nesmí na cloud.
"""
import sys
import re
import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import CACHE_DIR, SKILLS_DIR

sys.path.insert(0, str(Path(__file__).parent))
from parsers import parse_statement, BankStatement, Transaction
from gdrive_finance import get_bank_statements, COMPANY_NAMES
from llm_client import LLMClient, FINANCE_SYSTEM_PROMPT

# Contracts module — optional (graceful degradation if index missing)
try:
    sys.path.insert(0, str(SKILLS_DIR / 'contracts'))
    from contract_parser import load_index as _load_contract_index, ContractData
    _CONTRACTS_OK = True
except ImportError:
    _CONTRACTS_OK = False

ALL_COMPANIES = list(COMPANY_NAMES.keys())

# Transactions above this threshold are almost certainly parse errors (Revolut PDF artefacts)
_MAX_REALISTIC_TX = 5_000_000   # 5M CZK per single transaction

# Minimum average amount to include in annual/semi-annual section (avoid noise)
_MIN_PERIODIC_DISPLAY = 500     # Kč

# --- Intra-group detection ---

# Account number substrings (search in description text, stripped of separators)
_IG_ACCOUNTS = {
    '725710237': 'Baker Estates',
    'CZ8601000001310725710237': 'Baker Estates',
    '611930207': 'Pinehill',
    'CZ2101000001310611930207': 'Pinehill',
    '3425327002': 'PineAir',
}

# Substrings to match in counterparty / description (lowercase)
_IG_NAMES = [
    'baker estates', 'baker estate', 'pinehill', 'pineair', 'pine air',
    'pinehouse', 'pine house', 'pineinvest', 'pine invest', 'karel obluk',
]

# --- Self-transfer detection (technical, not real cash flow) ---
# Revolut FX conversions and wallet-to-wallet transfers within the same entity.
# These should be completely excluded from cashflow — they're balance-neutral operations.
_SELF_TRANSFER_KEYWORDS = [
    'main · ',                    # Revolut: "Main · USD –> Main · CZK" etc.
    'prevod mezi vlastnimi',      # Revolut CZ: wallet transfer to own account
    'převod mezi vlastními',      # variant with diacritics
    'vnitřní převod',             # generic internal transfer label
]

def _is_self_transfer(tx: Transaction) -> bool:
    """True for Revolut FX conversions and intra-entity wallet transfers."""
    text = f"{tx.description or ''} {tx.counterparty or ''}".lower()
    return any(kw in text for kw in _SELF_TRANSFER_KEYWORDS)


# --- Data classes ---

@dataclass
class PaymentPattern:
    key: str
    counterparty: str
    direction: str              # 'in' | 'out'
    amounts: list               # list[float]
    months_seen: list           # list[str]  YYYY/MM
    frequency: str              # 'monthly' | 'quarterly' | 'irregular' | 'one-time'
    contract: object            # ContractData | None
    is_intragroup: bool
    first_seen: str
    last_seen: str
    likely_ongoing: bool


@dataclass
class ProjectedMonth:
    month: str                  # YYYY/MM
    inflows: list               # list[tuple[str, float]]
    outflows: list              # list[tuple[str, float]]
    net: float
    est_balance: Optional[float] = None


@dataclass
class CashflowReport:
    company: str
    history_months: list        # sorted newest-first
    patterns: list              # list[PaymentPattern]  (excl. intragroup)
    intragroup: list            # list[PaymentPattern]
    projections: list           # list[ProjectedMonth]
    last_known_balance: Optional[float]


# --- Helpers ---

def _normalize_counterparty(tx: Transaction) -> str:
    name = (tx.counterparty or tx.description or '').strip()
    # Strip IBAN only (CZ + 2 check digits + 16 digits) — preserves Czech account numbers
    name = re.sub(r'\bCZ\d{2}[\d\s]{14,}\b', '', name, flags=re.IGNORECASE)
    # Normalize whitespace
    name = re.sub(r'\s+', ' ', name).strip()
    return name.lower()[:60] if name else 'unknown'


def _is_intragroup(tx: Transaction) -> tuple:
    """Returns (True, label) if intra-group, else (False, '')."""
    text = f"{tx.description or ''} {tx.counterparty or ''}".lower()
    for name in _IG_NAMES:
        if name in text:
            return True, name.title()
    stripped = re.sub(r'[\s/\-]', '', text)
    for acct, label in _IG_ACCOUNTS.items():
        if acct in stripped:
            return True, label
    return False, ''


def _detect_frequency(months_seen: list, total_months: int) -> str:
    n = len(set(months_seen))
    if total_months == 0 or n == 0:
        return 'one-time'
    ratio = n / total_months
    if ratio >= 0.75:
        return 'monthly'

    if total_months >= 10:
        # Full-year context: can detect annual patterns
        if n >= 3:
            return 'quarterly'
        if n == 2:
            ms = sorted(set(months_seen))
            ys, mns = int(ms[0][:4]), int(ms[0][5:7])
            ye, mne = int(ms[-1][:4]), int(ms[-1][5:7])
            gap = (ye - ys) * 12 + (mne - mns)
            return 'semi-annual' if gap >= 4 else 'irregular'
        # n == 1 in a full year — treat as annual, not one-time
        return 'annual'
    else:
        # Short history — can't distinguish annual from one-time
        if 0.3 <= ratio < 0.75:
            return 'quarterly'
        if n == 1:
            return 'one-time'
        return 'irregular'


def _match_contract(counterparty: str, contracts: list) -> object:
    """Fuzzy counterparty → ContractData match. Prefers entries with explicit payment_frequency."""
    if not contracts:
        return None
    cp = counterparty.lower()
    matches = []
    for c in contracts:
        cn = (c.counterparty or '').lower()
        if not cn or len(cn) < 4:
            continue
        # Exact substring or prefix match
        if cn in cp or cp.startswith(cn[:10]) or cn.startswith(cp[:10]):
            matches.append(c)
            continue
        # Word-overlap: ≥2 significant words (len≥4) from contract name appear in counterparty
        cn_words = {w for w in cn.split() if len(w) >= 4}
        if len(cn_words) >= 2 and sum(1 for w in cn_words if w in cp) >= 2:
            matches.append(c)
    if not matches:
        return None
    # Prefer entries with explicit payment_frequency (e.g. 'one-time') over empty ones
    with_freq = [c for c in matches if c.payment_frequency]
    return with_freq[0] if with_freq else matches[0]


def _parse_date_loose(s: str) -> Optional[datetime.date]:
    """Parse DD.MM.YYYY or YYYY date string. Returns None on failure."""
    if not s:
        return None
    try:
        parts = s.strip().split('.')
        if len(parts) == 3:
            return datetime.date(int(parts[2]), int(parts[1]), int(parts[0]))
        if len(s) == 4 and s.isdigit():
            return datetime.date(int(s), 12, 31)
    except (ValueError, IndexError):
        pass
    return None


def _prev_months(n: int) -> list:
    """Returns list of (year_str, month_str) for last N months, newest first."""
    today = datetime.date.today()
    result = []
    y, m = today.year, today.month
    for _ in range(n):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        result.append((str(y), f"{m:02d}"))
    return result


# --- Data loading ---

def load_history(company: str, months_back: int = 6) -> tuple:
    """
    Load bank statements for last N months.
    Returns (list[(month_str, BankStatement)], list[str] months_loaded newest-first).
    """
    month_stmts = []
    loaded = []
    for year, month in _prev_months(months_back):
        try:
            pdfs = get_bank_statements(company, year, month, CACHE_DIR)
        except Exception:
            continue
        if not pdfs:
            continue
        found_any = False
        for pdf in pdfs:
            try:
                stmt = parse_statement(pdf)
                month_stmts.append((f"{year}/{month}", stmt))
                found_any = True
            except Exception:
                continue
        if found_any:
            loaded.append(f"{year}/{month}")
    return month_stmts, loaded


def load_contracts(company: str) -> list:
    """Returns list[ContractData] or [] on any failure."""
    if not _CONTRACTS_OK:
        return []
    try:
        return _load_contract_index(company)
    except Exception:
        return []


# --- Classification ---

def classify_transactions(
    month_stmts: list,
    contracts: list,
    total_months: int,
    company: str = '',
) -> tuple:
    """
    Returns (patterns, ig_patterns, last_known_balance).
    patterns = list[PaymentPattern] for non-intragroup transactions
    ig_patterns = list[PaymentPattern] for intragroup transactions
    company: the company being analyzed — excluded from its own intragroup check
    """
    # Buckets keyed by direction + normalized counterparty
    buckets = defaultdict(lambda: {
        'amounts': [], 'months': [], 'contract': None, 'counterparty': ''
    })
    ig_buckets = defaultdict(lambda: {
        'amounts': [], 'months': [], 'counterparty': ''
    })
    skipped_outliers = 0
    last_balance = None

    for month_str, stmt in month_stmts:
        last_balance = float(stmt.closing_balance)
        for tx in stmt.transactions:
            amt = float(tx.amount)
            # Skip transactions with unrealistic amounts (Revolut/PDF parse errors)
            if abs(amt) > _MAX_REALISTIC_TX:
                skipped_outliers += 1
                print(f"  ⚠️  Přeskakuji podezřelou částku: {amt:,.0f} Kč — {tx.counterparty or tx.description}",
                      file=sys.stderr)
                continue

            # Skip FX conversions and intra-entity wallet transfers (balance-neutral, not real cash flow)
            if _is_self_transfer(tx):
                continue

            ig, ig_label = _is_intragroup(tx)
            # Same-company transfers (e.g. Pinehill Revolut → Pinehill KB) are self-transfers — skip entirely
            if ig and ig_label.lower().replace(' ', '') == company.lower().replace(' ', ''):
                continue
            if ig:
                direction = 'in' if amt > 0 else 'out'
                bkey = f"ig::{direction}::{ig_label.lower()}"
                ig_buckets[bkey]['amounts'].append(amt)
                ig_buckets[bkey]['months'].append(month_str)
                ig_buckets[bkey]['counterparty'] = ig_label
            else:
                cp = _normalize_counterparty(tx)
                direction = 'in' if amt > 0 else 'out'
                bkey = f"{direction}::{cp}"
                buckets[bkey]['amounts'].append(amt)
                buckets[bkey]['months'].append(month_str)
                buckets[bkey]['counterparty'] = cp
                if not buckets[bkey]['contract']:
                    buckets[bkey]['contract'] = _match_contract(cp, contracts)

    patterns = _build_patterns(buckets, total_months)
    ig_patterns = _build_ig_patterns(ig_buckets)
    return patterns, ig_patterns, last_balance


def _build_patterns(buckets: dict, total_months: int) -> list:
    patterns = []
    for key, data in buckets.items():
        direction = 'in' if key.startswith('in::') else 'out'
        months_unique = sorted(set(data['months']))
        c = data['contract']

        freq = _detect_frequency(data['months'], total_months)
        # Contract frequency overrides detected frequency when explicit
        if c and c.payment_frequency in ('monthly', 'quarterly', 'annual', 'one-time'):
            freq = c.payment_frequency  # 'one-time' → JEDNORÁZOVÉ even if seen once per year

        # High-value single occurrence without contract → treat as one-time, not annual.
        # Car purchases, equipment, property — large amounts that won't recur next year.
        avg_amt = sum(abs(a) for a in data['amounts']) / max(len(data['amounts']), 1)
        if freq == 'annual' and not c and avg_amt > 150_000:
            freq = 'one-time'

        # Lifecycle: expired contract → likely not ongoing
        likely_ongoing = True
        if c and c.end_date:
            ed = _parse_date_loose(c.end_date)
            if ed and ed < datetime.date.today():
                likely_ongoing = False

        if months_unique:
            last_m = months_unique[-1]
            today = datetime.date.today()
            last_date = datetime.date(int(last_m[:4]), int(last_m[5:7]), 1)
            months_ago = (today.year - last_date.year) * 12 + (today.month - last_date.month)
            # Quarterly pattern not seen for >5 months → terminated (e.g. Vlašic Roman)
            if freq == 'quarterly' and months_ago > 5 and not c:
                likely_ongoing = False
            # Monthly pattern not seen for >3 months → terminated
            if freq == 'monthly' and months_ago > 3 and not c:
                likely_ongoing = False
            # One-time in short history → don't project
            if freq == 'one-time' and months_ago > 2:
                likely_ongoing = False

        patterns.append(PaymentPattern(
            key=key,
            counterparty=data['counterparty'],
            direction=direction,
            amounts=data['amounts'],
            months_seen=data['months'],
            frequency=freq,
            contract=c,
            is_intragroup=False,
            first_seen=months_unique[0] if months_unique else '',
            last_seen=months_unique[-1] if months_unique else '',
            likely_ongoing=likely_ongoing,
        ))
    return patterns


def _build_ig_patterns(ig_buckets: dict) -> list:
    ig_patterns = []
    for key, data in ig_buckets.items():
        direction = 'in' if '::in::' in key else 'out'
        months_unique = sorted(set(data['months']))
        ig_patterns.append(PaymentPattern(
            key=key,
            counterparty=data['counterparty'],
            direction=direction,
            amounts=data['amounts'],
            months_seen=data['months'],
            frequency='irregular',
            contract=None,
            is_intragroup=True,
            first_seen=months_unique[0] if months_unique else '',
            last_seen=months_unique[-1] if months_unique else '',
            likely_ongoing=True,
        ))
    return ig_patterns


# --- Projection ---

def _fires_this_month(pattern: PaymentPattern, target: str) -> bool:
    """Check if a recurring pattern should fire in target (YYYY/MM)."""
    if pattern.frequency == 'monthly':
        return True

    if not pattern.months_seen:
        return False
    last = sorted(set(pattern.months_seen))[-1]
    ty, tm = int(target[:4]), int(target[5:7])
    ly, lm = int(last[:4]), int(last[5:7])
    diff = (ty - ly) * 12 + (tm - lm)

    if pattern.frequency == 'quarterly':
        return diff > 0 and diff % 3 == 0

    if pattern.frequency == 'semi-annual':
        return diff > 0 and diff % 6 == 0

    if pattern.frequency == 'annual':
        # Fire in the same calendar month(s) as historically observed
        observed_months = {int(m[5:7]) for m in pattern.months_seen}
        return tm in observed_months and diff > 0

    return False


def project_forward(
    patterns: list,
    months_ahead: int = 3,
    last_balance: Optional[float] = None,
) -> list:
    today = datetime.date.today()
    future = []
    y, m = today.year, today.month
    for _ in range(months_ahead):
        m += 1
        if m > 12:
            m, y = 1, y + 1
        future.append(f"{y:04d}/{m:02d}")

    projections = []
    balance = last_balance

    for month in future:
        month_date = datetime.date(int(month[:4]), int(month[5:7]), 1)
        inflows, outflows = [], []

        for p in patterns:
            if not p.likely_ongoing or p.is_intragroup:
                continue
            if not _fires_this_month(p, month):
                continue
            # Respect contract end_date
            if p.contract and p.contract.end_date:
                ed = _parse_date_loose(p.contract.end_date)
                if ed and ed < month_date:
                    continue

            avg = sum(abs(a) for a in p.amounts) / len(p.amounts) if p.amounts else 0
            label = p.counterparty.title()
            if p.contract:
                label += ' ✓'
            if p.direction == 'in':
                inflows.append((label, avg))
            else:
                outflows.append((label, avg))

        net = sum(a for _, a in inflows) - sum(a for _, a in outflows)
        if balance is not None:
            balance += net

        projections.append(ProjectedMonth(
            month=month,
            inflows=sorted(inflows, key=lambda x: -x[1]),
            outflows=sorted(outflows, key=lambda x: -x[1]),
            net=net,
            est_balance=balance,
        ))

    return projections


# --- Formatting ---

_MONTHS_CZ = ['', 'led', 'úno', 'bře', 'dub', 'kvě', 'čer',
               'čvc', 'srp', 'zář', 'říj', 'lis', 'pro']
_MONTHS_FULL = ['', 'leden', 'únor', 'březen', 'duben', 'květen', 'červen',
                'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec']


def _fmt(amount: float) -> str:
    return f"{amount:,.0f} Kč".replace(',', '\xa0')


def _month_label(ym: str, full: bool = False) -> str:
    try:
        y, m = int(ym[:4]), int(ym[5:7])
        name = _MONTHS_FULL[m] if full else _MONTHS_CZ[m]
        return f"{name} {y}"
    except (ValueError, IndexError):
        return ym


def _avg(amounts: list) -> float:
    return sum(abs(a) for a in amounts) / len(amounts) if amounts else 0.0


def format_report(report: CashflowReport) -> str:
    lines = [f"\n=== CASHFLOW PROJEKCE — {report.company.upper()} ==="]

    if not report.history_months:
        lines.append("⚠️  Žádná historická data nenalezena.")
        return '\n'.join(lines)

    oldest = report.history_months[-1] if len(report.history_months) > 1 else report.history_months[0]
    newest = report.history_months[0]
    lines.append(f"Data: {_month_label(oldest, True)} – {_month_label(newest, True)} ({len(report.history_months)} měs.)")
    if report.last_known_balance is not None:
        lines.append(f"Poslední zůstatek ({_month_label(newest, True)}): {_fmt(report.last_known_balance)}")

    _FREQ_LABELS = {
        'monthly': 'měsíčně',
        'quarterly': 'čtvrtletně',
        'semi-annual': 'pololetně',
        'annual': 'ročně',
        'irregular': 'nepravidelně',
    }

    # Separate patterns by cadence
    active = [p for p in report.patterns if p.likely_ongoing and p.frequency != 'one-time']
    # UKONČENO = was recurring but stopped; exclude one-time (those go to JEDNORÁZOVÉ only)
    inactive = [p for p in report.patterns if not p.likely_ongoing and p.frequency != 'one-time']
    one_time = [p for p in report.patterns if p.frequency == 'one-time']

    regular = [p for p in active if p.frequency in ('monthly', 'quarterly')]
    periodic = [p for p in active if p.frequency in ('semi-annual', 'annual')]

    rec_in = sorted([p for p in regular if p.direction == 'in'], key=lambda x: -_avg(x.amounts))
    rec_out = sorted([p for p in regular if p.direction == 'out'], key=lambda x: -_avg(x.amounts))
    per_in = sorted([p for p in periodic if p.direction == 'in'], key=lambda x: -_avg(x.amounts))
    per_out = sorted([p for p in periodic if p.direction == 'out'], key=lambda x: -_avg(x.amounts))

    def _row(p: PaymentPattern) -> str:
        avg = _avg(p.amounts)
        freq_lbl = _FREQ_LABELS.get(p.frequency, p.frequency)
        c_tag = ' [smlouva ✓]' if p.contract else ' [vzorec]'
        end_tag = f'  → konec {p.contract.end_date}' if p.contract and p.contract.end_date else ''
        n = len(set(p.months_seen))
        cp = p.counterparty.title()[:38]
        return f"  {cp:<38}  {_fmt(avg):>14}  {freq_lbl:<12}{c_tag}{end_tag}  ({n}× / {len(report.history_months)} měs.)"

    def _row_periodic(p: PaymentPattern) -> str:
        avg = _avg(p.amounts)
        freq_lbl = _FREQ_LABELS.get(p.frequency, p.frequency)
        c_tag = ' [smlouva ✓]' if p.contract else ' [vzorec ⚠️]'
        end_tag = f'  → konec {p.contract.end_date}' if p.contract and p.contract.end_date else ''
        n = len(set(p.months_seen))
        obs_months = ', '.join(_month_label(m) for m in sorted(set(p.months_seen)))
        cp = p.counterparty.title()[:38]
        return f"  {cp:<38}  {_fmt(avg):>14}  {freq_lbl:<12}{c_tag}{end_tag}  ({obs_months})"

    if rec_in:
        lines.append('\nPRAVIDELNÉ PŘÍJMY:')
        for p in rec_in:
            lines.append(_row(p))

    if rec_out:
        lines.append('\nPRAVIDELNÉ VÝDAJE:')
        for p in rec_out:
            lines.append(_row(p))

    per_in_show = [p for p in per_in if _avg(p.amounts) >= _MIN_PERIODIC_DISPLAY]
    per_out_show = [p for p in per_out if _avg(p.amounts) >= _MIN_PERIODIC_DISPLAY]
    if per_in_show or per_out_show:
        lines.append('\nROČNÍ / POLOLETNÍ PLATBY (projektovány v historickém měsíci):')
        for p in per_in_show + per_out_show:
            sign = '+' if p.direction == 'in' else '-'
            lines.append(f"{sign[0]}{_row_periodic(p)[1:]}")

    if one_time:
        lines.append('\nJEDNORÁZOVÉ (neprojektovány):')
        for p in one_time:
            avg = _avg(p.amounts)
            sign = '+' if p.direction == 'in' else '-'
            cp = p.counterparty.title()[:38]
            lines.append(f"  {cp:<38}  {sign}{_fmt(avg):>14}  {p.first_seen}")

    if inactive:
        lines.append('\nPRAVDĚPODOBNĚ UKONČENO (neprojektováno):')
        for p in inactive:
            avg = _avg(p.amounts)
            end_info = f'  konec {p.contract.end_date}' if p.contract and p.contract.end_date else ''
            cp = p.counterparty.title()[:38]
            lines.append(f"  {cp:<38}  {_fmt(avg):>14}{end_info}")

    if report.intragroup:
        lines.append('\nINTRA-GROUP — daňová optimalizace, ad hoc (neprojektováno):')
        ig_by_cp = defaultdict(lambda: {'in': [], 'out': [], 'months': []})
        for p in report.intragroup:
            ig_by_cp[p.counterparty][p.direction].extend(p.amounts)
            ig_by_cp[p.counterparty]['months'].extend(p.months_seen)
        for cp, data in sorted(ig_by_cp.items()):
            all_amounts = data['in'] + data['out']
            avg = _avg(all_amounts)
            n = len(set(data['months']))
            lines.append(f"  ↔ {cp.title():<36}  ø {_fmt(avg):>14}  ({n}× za {len(report.history_months)} měs.)")

    # Projections table
    if report.projections:
        lines.append('\n=== PROJEKCE (3 měsíce) ===')
        hdr = f"{'Měsíc':<14}  {'Příjmy':>14}  {'Výdaje':>14}  {'Čistý tok':>14}  {'Zůstatek':>14}"
        lines.append(hdr)
        lines.append('─' * len(hdr))
        for pm in report.projections:
            total_in = sum(a for _, a in pm.inflows)
            total_out = sum(a for _, a in pm.outflows)
            bal = _fmt(pm.est_balance) if pm.est_balance is not None else '           —'
            lines.append(
                f"{_month_label(pm.month, True):<14}  "
                f"{_fmt(total_in):>14}  "
                f"{_fmt(total_out):>14}  "
                f"{_fmt(pm.net):>14}  "
                f"{bal:>14}"
            )

        # Confidence
        recurring_freqs = ('monthly', 'quarterly', 'semi-annual', 'annual')
        n_rec = sum(1 for p in report.patterns if p.frequency in recurring_freqs)
        n_contract = sum(1 for p in report.patterns if p.contract and p.frequency in recurring_freqs)
        n_annual_unconfirmed = sum(1 for p in report.patterns if p.frequency == 'annual' and not p.contract)
        if n_rec > 0 and n_rec >= 3 and n_contract / max(n_rec, 1) >= 0.5:
            conf = 'Vysoká'
            conf_detail = f'smluvní základ ({n_contract}/{n_rec} vzorců)'
        elif len(report.history_months) >= 8:
            conf = 'Střední'
            conf_detail = f'{len(report.history_months)} měs. dat'
        else:
            conf = 'Nízká'
            conf_detail = f'málo dat ({len(report.history_months)} měs.)'
        note = f', {n_annual_unconfirmed} ročních vzorců bez smlouvy' if n_annual_unconfirmed else ''
        lines.append(f"\nSpolehlivost: {conf} — {conf_detail}{note}")

    return '\n'.join(lines)


# --- LLM context builder ---

def _llm_context(report: CashflowReport) -> str:
    lines = [f"Firma: {report.company.upper()}",
             f"Historická data: {len(report.history_months)} měsíců"]

    active = [p for p in report.patterns if p.likely_ongoing and p.frequency != 'one-time']
    for p in sorted(active, key=lambda x: -_avg(x.amounts)):
        avg = _avg(p.amounts)
        c_tag = f' [smlouva: {p.contract.contract_type}]' if p.contract else ''
        direction = 'Příjem' if p.direction == 'in' else 'Výdaj'
        lines.append(f"  {direction}: {p.counterparty.title()} ø {_fmt(avg)} {p.frequency}{c_tag}")

    if report.intragroup:
        ig_cps = list({p.counterparty for p in report.intragroup})
        lines.append(f"  Intra-group (ad hoc): {', '.join(ig_cps)}")

    if report.projections:
        lines.append("Projekce:")
        for pm in report.projections:
            total_in = sum(a for _, a in pm.inflows)
            total_out = sum(a for _, a in pm.outflows)
            lines.append(f"  {pm.month}: +{total_in:,.0f} / -{total_out:,.0f} = čistý tok {pm.net:,.0f} Kč")

    return '\n'.join(lines)


# --- Main ---

def run_cashflow(company: str, year: Optional[str] = None, question: str = '') -> str:
    """
    Main cashflow projection entry point.
    company: one of ALL_COMPANIES or 'all'
    year: ignored (used for multi-year future extension)
    question: optional user question for LLM
    """
    companies = ALL_COMPANIES if company in ('all', '') else [company]

    if company not in ALL_COMPANIES and company not in ('all', ''):
        return f"❌ Neznámá firma: {company}. Dostupné: {', '.join(ALL_COMPANIES)}, all"

    parts = []

    for comp in companies:
        print(f"  [{comp}] načítám historii (12 měs.)...", file=sys.stderr)
        month_stmts, history_months = load_history(comp, months_back=12)

        if not month_stmts:
            parts.append(f"\n⚠️  {comp.upper()}: žádné bankovní výpisy nenalezeny za posledních 12 měsíců.")
            continue

        contracts = load_contracts(comp)
        contracts_warn = '' if contracts else f"\n⚠️  Contracts index pro {comp} nenalezen — pro smluvní podklad spusť: /contracts {comp} index"

        patterns, ig_patterns, last_balance = classify_transactions(
            month_stmts, contracts, len(history_months), company=comp
        )

        projections = project_forward(patterns, months_ahead=3, last_balance=last_balance)

        report = CashflowReport(
            company=comp,
            history_months=history_months,
            patterns=patterns,
            intragroup=ig_patterns,
            projections=projections,
            last_known_balance=last_balance,
        )

        text = format_report(report)
        if contracts_warn:
            text += contracts_warn

        # LLM narrative
        q = question or "Zhodnoť cashflow projekci: hlavní rizika, neobvyklé vzorce, doporučení ke zlepšení likvidity."
        llm_prompt = f"{_llm_context(report)}\n\n---\nOtázka: {q}"
        llm = LLMClient(backend='ollama')
        try:
            narrative = llm.complete(llm_prompt, system=FINANCE_SYSTEM_PROMPT)
            text += f"\n\n=== ANALÝZA ===\n{narrative}"
        except Exception as e:
            text += f"\n\n⚠️  LLM analýza selhala: {e}"

        parts.append(text)

    separator = '\n\n' + '═' * 70 + '\n'
    return separator.join(parts)
