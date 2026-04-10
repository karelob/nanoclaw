"""
/finance skill — hlavní dispatcher.
Workflow: stáhnout z GDrive → parsovat → Ollama analýza → odpověď.

Použití:
  python3 finance.py baker 2025/03 výpis
  python3 finance.py baker 2025/03 faktury
  python3 finance.py baker 2025 Q1 cashflow
  python3 finance.py srovnej baker pinehill 2025
  python3 finance.py baker 2023 pmd
  python3 finance.py baker 2023 rozvaha
  python3 finance.py baker 2023 vzz
  python3 finance.py baker 2023 výkazy
  python3 finance.py baker 2023 analýza 'jak je na tom firma?'
"""
import sys
import re
import json
from pathlib import Path

# Shared path resolution (container vs host)
sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import CONE_SCRIPTS, TOKEN_FILE, CACHE_DIR, ensure_cone_scripts_importable

ensure_cone_scripts_importable()
import connectors.gdrive as _gdrive_mod
_gdrive_mod.TOKEN_FILE = TOKEN_FILE

from parsers import (parse_kb_bank_statement, parse_xlsx_cashflow, parse_pdf_text,
                     parse_statement, detect_bank_type, BankStatement)
from llm_client import LLMClient, FINANCE_SYSTEM_PROMPT
from gdrive_finance import get_bank_statements, get_invoices
from accounting import run_pmd, run_annual, analyze_annual_reports


def fmt_czk(amount: float) -> str:
    """Formátuje částku v CZK."""
    return f"{amount:,.0f} Kč".replace(',', '\xa0')


def analyze_bank_statement(stmt: BankStatement, user_question: str = '') -> str:
    """Sestaví kontext z bankovního výpisu a pošle Ollamě."""
    lines = [
        f"BANKOVNÍ VÝPIS — {stmt.company}",
        f"IBAN: {stmt.account_iban}",
        f"Období: {stmt.period_from} – {stmt.period_to}",
        f"Počáteční zůstatek: {fmt_czk(float(stmt.opening_balance))}",
        f"Konečný zůstatek:   {fmt_czk(float(stmt.closing_balance))}",
        f"Čistý tok:          {fmt_czk(float(stmt.closing_balance - stmt.opening_balance))}",
        f"Příchozí celkem:    {fmt_czk(float(stmt.total_in))}",
        f"Odchozí celkem:     {fmt_czk(float(stmt.total_out))}",
        f"Počet transakcí:    {len(stmt.transactions)}",
        "",
        "TRANSAKCE:",
    ]
    for t in stmt.transactions:
        sign = '+' if t.amount > 0 else ''
        vs_part = f" VS:{t.vs}" if t.vs else ''
        note_part = f"  [{t.note}]" if t.note else ''
        lines.append(f"  {t.date}  {sign}{float(t.amount):>12,.2f} {t.currency}{vs_part}  {t.description}{note_part}")

    context = '\n'.join(lines)
    prompt = f"{context}\n\n---\n"
    if user_question:
        prompt += f"Otázka: {user_question}"
    else:
        prompt += (
            "Proveď stručnou analýzu tohoto výpisu:\n"
            "1. Shrň pohyby (hlavní příjmy a výdaje)\n"
            "2. Identifikuj neobvyklé položky\n"
            "3. Zhodnoť likviditu\n"
            "Buď stručný, uváděj konkrétní čísla."
        )

    llm = LLMClient(backend='ollama')
    return llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT)


def run_bank_statement(company: str, year: str, month: str, user_q: str = '') -> str:
    """Stáhne a analyzuje bankovní výpis."""
    try:
        pdfs = get_bank_statements(company, year, month, CACHE_DIR)
    except Exception as e:
        return f"❌ Chyba při stahování výpisů: {e}"

    if not pdfs:
        return f"❌ Žádné výpisy nenalezeny pro {company} {year}/{month}"

    results = []
    for pdf in pdfs:
        try:
            bank = detect_bank_type(pdf)
            stmt = parse_statement(pdf)
            bank_label = {'kb': 'KB', 'rb': 'Raiffeisen', 'revolut': 'Revolut'}.get(bank, bank.upper())
            analysis = analyze_bank_statement(stmt, user_q)
            results.append(f"📄 *{pdf.name}* [{bank_label}]\n{analysis}")
        except Exception as e:
            results.append(f"⚠️ {pdf.name}: chyba parsování — {e}")

    return '\n\n---\n\n'.join(results)


def run_invoices(company: str, year: str, month: str, user_q: str = '') -> str:
    """Stáhne faktury a extrahuje text pro analýzu."""
    try:
        pdfs = get_invoices(company, year, month, cache_dir=CACHE_DIR)
    except Exception as e:
        return f"❌ Chyba při stahování faktur: {e}"

    if not pdfs:
        return f"❌ Žádné faktury nenalezeny pro {company} {year}/{month}"

    # Extrahuj text ze všech faktur
    invoice_texts = []
    for pdf in pdfs:
        try:
            text = parse_pdf_text(pdf)
            invoice_texts.append(f"=== {pdf.name} ===\n{text[:2000]}")
        except Exception as e:
            invoice_texts.append(f"=== {pdf.name} === [chyba: {e}]")

    context = f"FAKTURY — {company.upper()} {year}/{month}\nPočet: {len(pdfs)}\n\n"
    context += '\n\n'.join(invoice_texts)

    question = user_q or (
        "Shrň přijaté a vydané faktury: "
        "1) Celková hodnota přijatých faktur (DPH základ + DPH) "
        "2) Celková hodnota vydaných faktur "
        "3) Neobvyklé položky nebo chybějící faktury"
    )

    llm = LLMClient(backend='ollama')
    analysis = llm.complete(context + '\n\n---\nOtázka: ' + question, system=FINANCE_SYSTEM_PROMPT)
    return f"🧾 Faktury {company} {year}/{month} ({len(pdfs)} souborů)\n\n{analysis}"


def parse_args(args: list[str]) -> dict:
    """
    Parsuje argumenty příkazu /finance.
    Vrátí dict s klíči: action, company, year, month, question.
    """
    if not args:
        return {'action': 'help'}

    result = {'action': None, 'company': None, 'year': None, 'month': None, 'question': ''}

    # Detekce akce
    known_companies = ['baker', 'pinehill', 'pinehouse', 'pineinvest', 'pineair']
    actions_map = {
        'výpis': 'bank', 'vypis': 'bank', 'banka': 'bank',
        'faktury': 'invoices', 'faktura': 'invoices',
        'cashflow': 'cashflow',
        'srovnej': 'compare',
        'pmd': 'pmd', 'pohyby': 'pmd', 'daňový': 'pmd', 'danovy': 'pmd',
        'rozvaha': 'rozvaha',
        'vzz': 'vzz', 'výsledovka': 'vzz', 'vysledovka': 'vzz',
        'výkazy': 'annual', 'vykazy': 'annual',
        'analýza': 'analysis', 'analyza': 'analysis', 'účetnictví': 'analysis', 'ucetnictvi': 'analysis',
    }

    remaining = list(args)
    for i, a in enumerate(remaining):
        if a.lower() in actions_map:
            result['action'] = actions_map[a.lower()]
            remaining.pop(i)
            break

    # Detekce firmy
    for i, a in enumerate(remaining):
        if a.lower() in known_companies:
            result['company'] = a.lower()
            remaining.pop(i)
            break

    # Detekce roku/měsíce — formát "2025/03" nebo "2025" "03"
    for i, a in enumerate(remaining):
        m = re.match(r'^(\d{4})/(\d{2})$', a)
        if m:
            result['year'] = m.group(1)
            result['month'] = m.group(2)
            remaining.pop(i)
            break
        m2 = re.match(r'^(\d{4})$', a)
        if m2:
            result['year'] = m2.group(1)
            remaining.pop(i)
            # zkus vzít měsíc z dalšího arg
            if i < len(remaining) and re.match(r'^\d{2}$', remaining[i] if i < len(remaining) else ''):
                result['month'] = remaining[i]
                remaining.pop(i)
            break

    # Zbytek = otázka uživatele
    result['question'] = ' '.join(remaining)

    # Default action
    if result['action'] is None and result['company']:
        result['action'] = 'bank'

    return result


def main():
    args = sys.argv[1:]
    if not args:
        print("Použití: finance.py <firma> <rok/měsíc> <akce> [otázka]")
        print("Akce: výpis, faktury, cashflow, srovnej")
        print("Firmy: baker, pinehill, pinehouse, pineinvest, pineair")
        sys.exit(0)

    parsed = parse_args(args)
    action = parsed['action']
    company = parsed['company']
    year = parsed['year']
    month = parsed['month']
    question = parsed['question']

    if action == 'bank':
        if not all([company, year, month]):
            print(f"❌ Chybí firma/rok/měsíc. Zadáno: {parsed}")
            sys.exit(1)
        print(run_bank_statement(company, year, month, question))

    elif action == 'invoices':
        if not all([company, year, month]):
            print(f"❌ Chybí firma/rok/měsíc.")
            sys.exit(1)
        print(run_invoices(company, year, month, question))

    elif action == 'pmd':
        if not all([company, year]):
            print(f"❌ Chybí firma/rok.")
            sys.exit(1)
        print(run_pmd(company, year, question))

    elif action == 'rozvaha':
        if not all([company, year]):
            print(f"❌ Chybí firma/rok.")
            sys.exit(1)
        print(run_annual(company, year, question))

    elif action == 'vzz':
        if not all([company, year]):
            print(f"❌ Chybí firma/rok.")
            sys.exit(1)
        print(run_annual(company, year, question))

    elif action == 'annual':
        if not all([company, year]):
            print(f"❌ Chybí firma/rok.")
            sys.exit(1)
        print(run_annual(company, year, question))

    elif action == 'analysis':
        if not all([company, year]):
            print(f"❌ Chybí firma/rok.")
            sys.exit(1)
        # Kompletní analýza — PMD + výkazy s LLM
        pmd_out = run_pmd(company, year)
        annual_out = run_annual(company, year)
        context = f"{pmd_out}\n\n{'=' * 60}\n\n{annual_out}"
        if question:
            analysis = analyze_annual_reports(company, year, question)
            print(f"{context}\n\n--- ANALÝZA ---\n{analysis}")
        else:
            analysis = analyze_annual_reports(company, year)
            print(f"{context}\n\n--- ANALÝZA ---\n{analysis}")

    elif action == 'help' or action is None:
        print("Použití: finance.py <firma> <rok/měsíc> <akce>")
        print("Akce: výpis, faktury, pmd, rozvaha, vzz, výkazy, analýza")

    else:
        print(f"⚠️ Akce '{action}' zatím není implementována.")


if __name__ == '__main__':
    main()
