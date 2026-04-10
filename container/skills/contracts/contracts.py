"""
/contracts skill — smluvní závazky firem Karla Obluka.
Extrahuje strukturovaná data ze smluv: pronájmy, úvěry, HR, auta, služby.
Přírůstkový index, křížová kontrola pro cashflow projekce.
Vždy Ollama — citlivá data nesmí na cloud.

Použití:
  python3 contracts.py pinehill list         # přehled všech smluv
  python3 contracts.py pinehill platby       # platební závazky (cashflow)
  python3 contracts.py pinehill hr           # HR smlouvy a dohody
  python3 contracts.py all platby            # cross-company platební přehled
  python3 contracts.py expiring              # expirující smlouvy (90 dní)
  python3 contracts.py expiring 30           # expirující do 30 dní
  python3 contracts.py pinehill index        # indexuj / aktualizuj index
  python3 contracts.py pinehill index --force  # přeindexuj vše
  python3 contracts.py pinehill scan        # náhled: kolik souborů bez indexace
"""
import sys
import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import SKILLS_DIR

from contract_parser import load_index, build_index, ContractData, _make_llm
from gdrive_contracts import COMPANY_FOLDERS, count_files

sys.path.insert(0, str(SKILLS_DIR / 'finance'))
from llm_client import FINANCE_SYSTEM_PROMPT

ALL_COMPANIES = list(COMPANY_FOLDERS.keys())

# Překlady
_FREQ_CZ = {
    'monthly': 'měsíčně',
    'quarterly': 'čtvrtletně',
    'annual': 'ročně',
    'one-time': 'jednorázově',
    'irregular': 'nepravidelně',
    '': '',
}
_TYPE_CZ = {
    'rental': 'Nájem',
    'loan': 'Zápůjčka/Úvěr',
    'service': 'Služby',
    'hr': 'HR',
    'vehicle': 'Vozidlo',
    'consulting': 'Konzultace',
    'corporate': 'Firemní',
    'finance': 'Finance',
    'other': 'Ostatní',
}
_EMPL_CZ = {
    'HPP': 'HPP',
    'DPP': 'DPP',
    'DPČ': 'DPČ',
    '': '',
}


def _fmt_amount(c: ContractData) -> str:
    if not c.payment_amount:
        return '—'
    freq = _FREQ_CZ.get(c.payment_frequency, c.payment_frequency)
    s = f"{c.payment_amount:,.0f} {c.payment_currency}"
    return f"{s} / {freq}" if freq else s


def _resolve_companies(company_arg: str) -> list[str]:
    if company_arg == 'all':
        return ALL_COMPANIES
    if company_arg not in ALL_COMPANIES:
        print(f"❌ Neznámá firma: {company_arg}. Dostupné: {', '.join(ALL_COMPANIES)}, all")
        sys.exit(1)
    return [company_arg]


# --- Akce ---

def run_list(company: str) -> str:
    lines = []
    for comp in _resolve_companies(company):
        contracts = load_index(comp)
        if not contracts:
            lines.append(f"⚠️  {comp}: prázdný index — spusť `{comp} index`")
            continue
        lines.append(f"\n**{comp.upper()}** ({len(contracts)} smluv)")
        for c in sorted(contracts, key=lambda x: (x.contract_type, x.counterparty)):
            typ = _TYPE_CZ.get(c.contract_type, c.contract_type)
            amt = _fmt_amount(c)
            end = f" → {c.end_date}" if c.end_date else ''
            empl = f" [{_EMPL_CZ[c.employment_type]}]" if c.employment_type else ''
            lines.append(f"  • [{typ}{empl}] **{c.counterparty}**{end} — {amt}")
            if c.description:
                lines.append(f"    _{c.description}_")
    return '\n'.join(lines)


def run_payments(company: str) -> str:
    """Smluvní platební závazky — podklad pro cashflow projekci."""
    recurring: list[dict] = []
    one_time: list[dict] = []
    no_amount: list[dict] = []

    for comp in _resolve_companies(company):
        for c in load_index(comp):
            entry = {
                'company': comp,
                'counterparty': c.counterparty,
                'type': c.contract_type,
                'empl': c.employment_type,
                'amount': c.payment_amount,
                'currency': c.payment_currency,
                'frequency': c.payment_frequency,
                'end_date': c.end_date,
                'description': c.description,
            }
            if not c.payment_amount:
                no_amount.append(entry)
            elif c.payment_frequency in ('monthly', 'quarterly', 'annual'):
                recurring.append(entry)
            else:
                one_time.append(entry)

    lines = ['## Smluvní platební závazky\n']

    if recurring:
        lines.append('### Pravidelné platby')
        for e in sorted(recurring, key=lambda x: (-x['amount'], x['company'])):
            freq = _FREQ_CZ.get(e['frequency'], e['frequency'])
            end = f" (do {e['end_date']})" if e['end_date'] else ''
            empl = f" [{e['empl']}]" if e['empl'] else ''
            typ = _TYPE_CZ.get(e['type'], e['type'])
            lines.append(
                f"  • **{e['counterparty']}**{empl} ({e['company']}, {typ}){end}"
                f" — {e['amount']:,.0f} {e['currency']} {freq}"
            )
            if e['description']:
                lines.append(f"    _{e['description']}_")

    if one_time:
        lines.append('\n### Jednorázové / nepravidelné')
        for e in one_time:
            typ = _TYPE_CZ.get(e['type'], e['type'])
            lines.append(
                f"  • **{e['counterparty']}** ({e['company']}, {typ})"
                f" — {e['amount']:,.0f} {e['currency']}"
            )
            if e['description']:
                lines.append(f"    _{e['description']}_")

    if no_amount:
        lines.append(f"\n### Bez evidované částky ({len(no_amount)} smluv)")
        for e in no_amount:
            typ = _TYPE_CZ.get(e['type'], e['type'])
            lines.append(f"  • {e['counterparty']} ({e['company']}, {typ})")

    # LLM shrnutí
    if recurring or one_time:
        context = '\n'.join(lines)
        llm = _make_llm()
        prompt = (
            f"{context}\n\n---\n"
            "Shrň tyto smluvní závazky z pohledu cashflow projekce. "
            "Jaký je celkový měsíční závazek? "
            "Upozorni na brzy expirující smlouvy nebo neobvyklé podmínky. "
            "Pro HR smlouvy odliš HPP (plné odvody) vs DPP/DPČ (jiné daňové dopady)."
        )
        analysis = llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT)
        lines.append(f"\n---\n{analysis}")

    return '\n'.join(lines)


def run_hr(company: str) -> str:
    """HR smlouvy — zaměstnanecké i dohody, s daňovými implikacemi."""
    lines = ['## HR smlouvy a dohody\n']
    found = False

    for comp in _resolve_companies(company):
        hr_contracts = [c for c in load_index(comp) if c.contract_type == 'hr']
        if not hr_contracts:
            continue
        found = True
        lines.append(f"**{comp.upper()}**")
        for c in sorted(hr_contracts, key=lambda x: x.employee_name or x.counterparty):
            name = c.employee_name or c.counterparty
            empl = _EMPL_CZ.get(c.employment_type, c.employment_type) or 'neznámý typ'
            end = f" (do {c.end_date})" if c.end_date else ' (neurčito)'
            lines.append(f"  • **{name}** — {empl}{end}")
            if c.payment_amount:
                lines.append(f"    Hrubá: {c.payment_amount:,.0f} {c.payment_currency} / měsíc")
                # Odhadované odvody pro HPP
                if c.employment_type == 'HPP':
                    employer_levy = c.payment_amount * 0.338
                    total_cost = c.payment_amount + employer_levy
                    lines.append(
                        f"    Celkový náklad (hrubá + odvody zaměstnavatele ~33,8 %): "
                        f"{total_cost:,.0f} {c.payment_currency} / měsíc"
                    )
            if c.description:
                lines.append(f"    _{c.description}_")
        lines.append('')

    if not found:
        lines.append('Žádné HR smlouvy nenalezeny v indexu.')

    return '\n'.join(lines)


def run_expiring(days: int = 90) -> str:
    """Smlouvy expirující v příštích N dnech."""
    today = datetime.date.today()
    cutoff = today + datetime.timedelta(days=days)

    expiring: list[tuple[datetime.date, str, ContractData]] = []
    indefinite: list[tuple[str, ContractData]] = []

    for comp in ALL_COMPANIES:
        for c in load_index(comp):
            if not c.end_date:
                if c.contract_type in ('rental', 'service', 'hr', 'vehicle'):
                    indefinite.append((comp, c))
                continue
            end_date = _parse_date(c.end_date)
            if end_date and end_date <= cutoff:
                expiring.append((end_date, comp, c))

    expiring.sort(key=lambda x: x[0])

    lines = [f"## Smlouvy expirující do {days} dní\n"]

    for end_date, comp, c in expiring:
        days_left = (end_date - today).days
        icon = '🔴' if days_left <= 30 else '🟡' if days_left <= 60 else '🟢'
        typ = _TYPE_CZ.get(c.contract_type, c.contract_type)
        lines.append(
            f"{icon} **{c.counterparty}** ({comp}, {typ}) — "
            f"expiruje {end_date.strftime('%d.%m.%Y')} (za {days_left} dní)"
        )
        if c.description:
            lines.append(f"   _{c.description}_")

    if not expiring:
        lines.append(f'Žádné smlouvy expirující do {days} dní.\n')

    if indefinite:
        lines.append(f"\n### Smlouvy bez data ukončení ({len(indefinite)})")
        for comp, c in indefinite:
            typ = _TYPE_CZ.get(c.contract_type, c.contract_type)
            notice = f" (výpověď {c.notice_period_days} dní)" if c.notice_period_days else ''
            lines.append(f"  • {c.counterparty} ({comp}, {typ}){notice}")

    return '\n'.join(lines)


def run_index(company: str, force: bool = False) -> str:
    lines = []
    for comp in _resolve_companies(company):
        print(f"⏳ Indexuji {comp}...", flush=True)
        contracts, new_count, skipped = build_index(comp, force=force, verbose=True)
        lines.append(
            f"✅ {comp}: {len(contracts)} smluv"
            f" ({new_count} nových, {skipped} beze změny)"
        )
    return '\n'.join(lines)


def run_scan(company: str) -> str:
    """Rychlý přehled dostupných souborů před indexací."""
    lines = []
    for comp in _resolve_companies(company):
        counts = count_files(comp)
        total = sum(counts.values())
        lines.append(f"**{comp}**: {total} souborů")
        for cat, n in sorted(counts.items(), key=lambda x: -x[1]):
            typ = _TYPE_CZ.get(cat, cat)
            lines.append(f"  {typ}: {n}")
    return '\n'.join(lines)


def _parse_date(s: str) -> datetime.date | None:
    """Parsuj datum z různých formátů."""
    if not s:
        return None
    # DD.MM.YYYY
    parts = s.split('.')
    if len(parts) == 3:
        try:
            return datetime.date(int(parts[2]), int(parts[1]), int(parts[0]))
        except ValueError:
            pass
    # YYYY
    if len(s) == 4 and s.isdigit():
        try:
            return datetime.date(int(s), 12, 31)
        except ValueError:
            pass
    # ISO
    try:
        return datetime.date.fromisoformat(s[:10])
    except ValueError:
        return None


def run_timeline_review(args: list[str]) -> str:
    """Spustí temporal review agent."""
    from contract_timeline import run_review, promote_confirmed, REVIEW_FILE, ACTIVE_FILE

    if 'promote' in args:
        promoted, remaining = promote_confirmed()
        return f"✅ Přesunuto do active_contracts.yaml: {promoted}\nZbývá ke kontrole: {remaining}\nSoubor: {ACTIVE_FILE}"

    companies_arg = [a for a in args if a in ALL_COMPANIES]
    companies = companies_arg if companies_arg else None
    personal = '--no-personal' not in args
    force = '--force' in args

    print("⏳ Spouštím temporal review agent...", flush=True)
    if companies:
        print(f"   Firmy: {', '.join(companies)}", flush=True)
    if personal:
        print("   + osobní dokumenty (iCloud)", flush=True)
    print(f"   Výstup: {REVIEW_FILE}", flush=True)
    print()

    out = run_review(companies=companies, include_personal=personal, force=force, verbose=True)
    return f"\nHotovo. Otevři {out} a vyplň Karel_status pro každý záznam.\nPak spusť: /contracts review promote"


def main():
    args = sys.argv[1:]

    if not args or args[0] in ('-h', '--help', 'help'):
        print(__doc__)
        sys.exit(0)

    # Speciální příkaz bez firmy
    if args[0].lower() in ('expiring', 'expirace'):
        days = int(args[1]) if len(args) > 1 and args[1].isdigit() else 90
        print(run_expiring(days))
        return

    if args[0].lower() == 'review':
        print(run_timeline_review(args[1:]))
        return

    company = args[0].lower()
    action = args[1].lower() if len(args) > 1 else 'list'
    extra = args[2:] if len(args) > 2 else []

    if action == 'list':
        print(run_list(company))
    elif action in ('platby', 'payments', 'cashflow'):
        print(run_payments(company))
    elif action == 'hr':
        print(run_hr(company))
    elif action in ('expiring', 'expirace'):
        days = int(extra[0]) if extra and extra[0].isdigit() else 90
        print(run_expiring(days))
    elif action == 'index':
        force = '--force' in extra
        print(run_index(company, force=force))
    elif action == 'scan':
        print(run_scan(company))
    elif action == 'review':
        print(run_timeline_review(extra))
    else:
        print(f"⚠️  Neznámá akce: {action}")
        print("Dostupné akce: list, platby, hr, expiring, index, index --force, scan, review")


if __name__ == '__main__':
    main()
