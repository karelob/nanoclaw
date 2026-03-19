"""
Finance Parsers — KB bankovní výpis (PDF), faktury (PDF), XLSX cashflow.
Read-only — žádná modifikace zdrojových dat.
"""
import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from decimal import Decimal, InvalidOperation


@dataclass
class Transaction:
    date: str           # DD.MM.YYYY
    description: str    # popis transakce
    counterparty: str   # název protiúčtu
    amount: Decimal     # + příjem, - výdaj
    currency: str = 'CZK'
    vs: str = ''        # variabilní symbol
    note: str = ''      # popis pro mě

    def to_dict(self):
        return {
            'date': self.date,
            'description': self.description,
            'counterparty': self.counterparty,
            'amount': float(self.amount),
            'currency': self.currency,
            'vs': self.vs,
            'note': self.note,
        }


@dataclass
class BankStatement:
    company: str
    account_iban: str
    period_from: str
    period_to: str
    currency: str
    opening_balance: Decimal
    closing_balance: Decimal
    transactions: list[Transaction] = field(default_factory=list)

    @property
    def total_in(self):
        return sum(t.amount for t in self.transactions if t.amount > 0)

    @property
    def total_out(self):
        return sum(t.amount for t in self.transactions if t.amount < 0)

    def summary(self):
        return {
            'company': self.company,
            'iban': self.account_iban,
            'period': f"{self.period_from} – {self.period_to}",
            'currency': self.currency,
            'opening_balance': float(self.opening_balance),
            'closing_balance': float(self.closing_balance),
            'total_in': float(self.total_in),
            'total_out': float(self.total_out),
            'transaction_count': len(self.transactions),
        }


def _parse_amount(s: str) -> Optional[Decimal]:
    """Převede '1 234 567,89' → Decimal('1234567.89')"""
    if not s:
        return None
    s = s.strip().replace('\xa0', '').replace(' ', '').replace(',', '.')
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def parse_kb_bank_statement(pdf_path: Path) -> BankStatement:
    """
    Parsuje Komerční banka periodický výpis z PDF.
    Používá souřadnice slov (pdfplumber) pro spolehlivé oddělení
    částky, VS a popisu — imunní vůči kolizím číslic.

    Sloupce KB výpisu (x-souřadnice):
      Datum       x ≈ 48
      Typ/Popis   90 ≤ x ≤ 410
      VS          410 < x ≤ 510
      Částka      x > 510
    """
    import pdfplumber

    full_text = []
    all_pages_words = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                full_text.append(text)
            words = page.extract_words()
            all_pages_words.append(words)

    text = '\n'.join(full_text)

    # --- Metadata z textu ---
    iban_m = re.search(r'IBAN:\s*(CZ\d+)', text)
    period_m = re.search(r'Za období:\s*(\d{2}\.\d{2}\.)\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})', text)
    currency_m = re.search(r'měna:\s*(\w+)', text)
    opening_m = re.search(r'Počáteční zůstatek\s+([\d\s]+,\d{2})', text)
    closing_m = re.search(r'Konečný zůstatek\s+([\d\s]+,\d{2})', text)
    company_m = re.search(r'(BAKER ESTATES|PINEHILL|PINEHOUSE|PINEINVEST|PINEAIR)\s+S\.R\.O\.', text, re.IGNORECASE)

    iban = iban_m.group(1) if iban_m else ''
    period_to = period_m.group(2) if period_m else ''
    period_from = period_m.group(1) + period_to[-4:] if period_m else ''
    currency = currency_m.group(1) if currency_m else 'CZK'
    opening = _parse_amount(opening_m.group(1)) if opening_m else Decimal(0)
    closing = _parse_amount(closing_m.group(1)) if closing_m else Decimal(0)
    company = company_m.group(1).title() if company_m else pdf_path.stem

    # --- Parsování transakcí pomocí souřadnic ---
    transactions = []
    date_re = re.compile(r'^\d{2}\.\d{2}\.\d{4}$')
    amount_re = re.compile(r'^-?\d{1,3}(?:\s\d{3})*,\d{2}$')

    for page_words in all_pages_words:
        if not page_words:
            continue

        # Seskup slova do řádků podle y-souřadnice (tolerance 3pt)
        rows = {}
        for w in page_words:
            y = round(w['top'] / 3) * 3
            rows.setdefault(y, []).append(w)

        # Seřaď řádky od shora dolů
        for y_key in sorted(rows.keys()):
            row_words = sorted(rows[y_key], key=lambda w: w['x0'])

            # Řádek transakce začíná datem (první slovo)
            if not row_words:
                continue
            first_word = row_words[0]['text']
            if not date_re.match(first_word):
                continue

            date = first_word

            # Rozděl zbývající slova podle sloupců
            desc_words = [w for w in row_words if 90 <= w['x0'] <= 410]
            vs_words   = [w for w in row_words if 410 < w['x0'] <= 510]
            amt_words  = [w for w in row_words if w['x0'] > 510]

            # Částka — spoj slova a ověř formát
            amount_str = ' '.join(w['text'] for w in amt_words).strip()
            # Odstraň případné nečíselné znaky (záhlaví apod.)
            amount_str = re.sub(r'[^\d\s,\-]', '', amount_str).strip()
            if not amount_re.match(amount_str):
                continue
            amount = _parse_amount(amount_str)
            if amount is None or amount == 0:
                continue

            description_part = ' '.join(w['text'] for w in desc_words).strip()
            vs = ' '.join(w['text'] for w in vs_words).strip()
            # VS musí být čistě číselné
            if vs and not re.match(r'^\d+$', vs):
                vs = ''

            # Filtruj řádky denní zůstatkové tabulky — popis obsahuje datum uvnitř
            if re.search(r'\d{2}\.\d{2}\.\d{4}', description_part):
                continue

            # Znak přichází přímo z PDF — žádná keyword detekce
            transactions.append(Transaction(
                date=date,
                description=description_part,
                counterparty='',
                amount=amount,
                currency=currency,
                vs=vs,
                note='',
            ))

    return BankStatement(
        company=company,
        account_iban=iban,
        period_from=period_from,
        period_to=period_to,
        currency=currency,
        opening_balance=opening,
        closing_balance=closing,
        transactions=transactions,
    )


def parse_xlsx_cashflow(xlsx_path: Path) -> dict:
    """
    Parsuje cashflow plán z XLSX.
    Vrací dict s klíči: company, rows (list dicts), months.
    """
    import openpyxl
    wb = openpyxl.load_workbook(str(xlsx_path), read_only=True, data_only=True)
    result = {'file': xlsx_path.name, 'sheets': {}}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            if any(cell is not None for cell in row):
                rows.append(list(row))
        result['sheets'][sheet_name] = rows[:100]  # max 100 řádků

    return result


def parse_pdf_text(pdf_path: Path) -> str:
    """Extrahuje veškerý text z PDF (výsledovky, faktury, apod.)"""
    import pdfplumber
    texts = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                texts.append(t)
    return '\n'.join(texts)


if __name__ == '__main__':
    # Test
    stmt = parse_kb_bank_statement(Path('/tmp/baker_bu_sample.pdf'))
    print(stmt.summary())
    print(f"\nPrvní 3 transakce:")
    for t in stmt.transactions[:3]:
        print(f"  {t.date} {t.amount:>12} {t.currency}  {t.description[:40]}  {t.vs}")
