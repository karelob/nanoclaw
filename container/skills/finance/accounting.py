"""
České účetnictví — parser PMD exportů a DPPO/Rozvaha/VZZ výkazů.

PMD = Pohyby na daňovém účtu (CSV export z Finanční správy).
DPPO = Daňové přiznání z příjmů právnických osob.
Rozvaha = Balance sheet (aktiva/pasiva).
VZZ = Výkaz zisku a ztráty (P&L).

Read-only — nikdy nemodifikuje zdrojová data.
Citlivá data — pouze Ollama, nikdy cloud LLM.
"""
import csv
import io
import re
import sys
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

# Shared path resolution (container vs host)
sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import CONE_DB, CONE_CONFIG, load_env_var

from parsers import parse_pdf_text, _parse_amount
from gdrive_finance import (
    _local_accounting_path, _collect_local_files,
    COMPANY_NAMES, ACCOUNTING_NAMES,
)
from llm_client import LLMClient, FINANCE_SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class PMDEntry:
    """Jeden řádek PMD exportu (pohyb na daňovém účtu)."""
    financni_urad: str
    uzemni_pracoviste: str
    druh_prijmu: str           # typ daně (DPPO, DPH, ...)
    platcova_pokladna: str
    popis: str                 # popis obratu
    datum: str                 # DD.MM.YYYY
    ma_dati: Optional[Decimal]  # platba (úhrada) — peníze odchází
    dal: Optional[Decimal]     # přeplatek / vrácení — peníze přichází

    @property
    def amount(self) -> Decimal:
        """Kladné = platba státu (Má dáti), záporné = příjem od státu (Dal)."""
        if self.ma_dati:
            return self.ma_dati
        if self.dal:
            return -self.dal
        return Decimal(0)

    @property
    def datum_sort(self) -> str:
        """YYYY-MM-DD formát pro řazení."""
        parts = self.datum.split('.')
        if len(parts) == 3:
            return f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
        return self.datum

    def to_dict(self) -> dict:
        return {
            'financni_urad': self.financni_urad,
            'uzemni_pracoviste': self.uzemni_pracoviste,
            'druh_prijmu': self.druh_prijmu,
            'popis': self.popis,
            'datum': self.datum,
            'ma_dati': float(self.ma_dati) if self.ma_dati else None,
            'dal': float(self.dal) if self.dal else None,
            'amount': float(self.amount),
        }


@dataclass
class PMDReport:
    """Kompletní PMD export pro jednu firmu/rok."""
    company: str
    year: str
    entries: list[PMDEntry] = field(default_factory=list)

    @property
    def total_paid(self) -> Decimal:
        """Celkem zaplaceno státu (Má dáti)."""
        return sum((e.ma_dati for e in self.entries if e.ma_dati), Decimal(0))

    @property
    def total_received(self) -> Decimal:
        """Celkem přijato od státu (Dal)."""
        return sum((e.dal for e in self.entries if e.dal), Decimal(0))

    @property
    def net(self) -> Decimal:
        """Čistý tok (kladné = zaplaceno víc než vráceno)."""
        return self.total_paid - self.total_received

    def by_tax_type(self) -> dict[str, list[PMDEntry]]:
        """Seskupení podle druhu příjmu (daně)."""
        groups: dict[str, list[PMDEntry]] = {}
        for e in self.entries:
            groups.setdefault(e.druh_prijmu, []).append(e)
        return groups

    def by_month(self) -> dict[str, list[PMDEntry]]:
        """Seskupení podle měsíce (YYYY-MM)."""
        months: dict[str, list[PMDEntry]] = {}
        for e in self.entries:
            parts = e.datum.split('.')
            if len(parts) == 3:
                key = f"{parts[2]}-{parts[1].zfill(2)}"
            else:
                key = 'unknown'
            months.setdefault(key, []).append(e)
        return dict(sorted(months.items()))

    def summary(self) -> dict:
        return {
            'company': self.company,
            'year': self.year,
            'entries_count': len(self.entries),
            'total_paid': float(self.total_paid),
            'total_received': float(self.total_received),
            'net': float(self.net),
        }


@dataclass
class RozvahaData:
    """Strukturovaná data z Rozvahy (Balance sheet)."""
    company: str
    year: str
    # Jednotky (typicky 1000 Kč)
    units: str
    # Aktiva
    aktiva_celkem: Optional[Decimal] = None
    stala_aktiva: Optional[Decimal] = None
    obezna_aktiva: Optional[Decimal] = None
    penezni_prostredky: Optional[Decimal] = None
    pohledavky: Optional[Decimal] = None
    casove_rozliseni_aktiv: Optional[Decimal] = None
    # Pasiva
    pasiva_celkem: Optional[Decimal] = None
    vlastni_kapital: Optional[Decimal] = None
    zakladni_kapital: Optional[Decimal] = None
    vsledek_hospodareni_bezne: Optional[Decimal] = None
    vsledek_hospodareni_minule: Optional[Decimal] = None
    cizi_zdroje: Optional[Decimal] = None
    zavazky: Optional[Decimal] = None
    # Surový text pro LLM analýzu
    raw_text: str = ''

    def summary(self) -> dict:
        return {k: (float(v) if isinstance(v, Decimal) else v)
                for k, v in self.__dict__.items() if k != 'raw_text' and v is not None}


@dataclass
class VZZData:
    """Strukturovaná data z Výkazu zisku a ztráty (P&L)."""
    company: str
    year: str
    units: str
    # Hlavní řádky
    trzby_vyrobky_sluzby: Optional[Decimal] = None
    vykonova_spotreba: Optional[Decimal] = None
    osobni_naklady: Optional[Decimal] = None
    odpisy: Optional[Decimal] = None
    provozni_vysledek: Optional[Decimal] = None
    financni_vysledek: Optional[Decimal] = None
    vysledek_pred_zdanenim: Optional[Decimal] = None
    dan_z_prijmu: Optional[Decimal] = None
    vysledek_po_zdaneni: Optional[Decimal] = None
    cisty_obrat: Optional[Decimal] = None
    nakladove_uroky: Optional[Decimal] = None
    # Surový text pro LLM analýzu
    raw_text: str = ''

    def summary(self) -> dict:
        return {k: (float(v) if isinstance(v, Decimal) else v)
                for k, v in self.__dict__.items() if k != 'raw_text' and v is not None}


@dataclass
class DPPOData:
    """Strukturovaná data z DPPO přiznání."""
    company: str
    year: str
    ico: str = ''
    dic: str = ''
    # Klíčové řádky II. oddílu
    vysledek_hospodareni: Optional[Decimal] = None      # ř. 10
    neuznane_naklady: Optional[Decimal] = None           # ř. 40
    zaklad_dane: Optional[Decimal] = None                # ř. 200/220
    dan: Optional[Decimal] = None                        # ř. 290
    slevy_na_dani: Optional[Decimal] = None              # ř. 300
    dan_po_sleve: Optional[Decimal] = None               # ř. 310
    zaplacene_zalohy: Optional[Decimal] = None           # ř. 340
    doplatek: Optional[Decimal] = None                   # ř. 360/370
    raw_text: str = ''

    def summary(self) -> dict:
        return {k: (float(v) if isinstance(v, Decimal) else v)
                for k, v in self.__dict__.items() if k != 'raw_text' and v is not None}


# ---------------------------------------------------------------------------
# PMD CSV Parser
# ---------------------------------------------------------------------------

def _parse_pmd_amount(s: str) -> Optional[Decimal]:
    """Parsuje PMD částku: '170500,00 Kč' → Decimal('170500.00')."""
    if not s or not s.strip():
        return None
    s = s.strip().replace('\xa0', '').replace(' ', '')
    s = s.replace('Kč', '').replace('kč', '').strip()
    s = s.replace(',', '.')
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def parse_pmd_csv(csv_path: Path) -> PMDReport:
    """
    Parsuje CSV export pohybů na daňovém účtu.

    Formát: UTF-8 s BOM, středník jako oddělovač, uvozovky.
    Sloupce: Finanční úřad; Územní pracoviště; Druh příjmu;
             Plátcova pokladna; Popis obratu; Datum; Má dáti; Dal

    Args:
        csv_path: Cesta k PMD CSV souboru.

    Returns:
        PMDReport s rozparsovanými záznamy.
    """
    raw = csv_path.read_bytes()

    # Detekce kódování — PMD export je typicky UTF-8 s BOM
    for enc in ('utf-8-sig', 'utf-8', 'cp1250', 'iso-8859-2'):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError(f"Nepodařilo se dekódovat {csv_path.name}")

    # Extrahuj rok a firmu z názvu souboru
    # Typický formát: "2024_01_pohyby na daňovém účtu 2023 - Baker.csv"
    name = csv_path.stem
    year_match = re.search(r'účtu\s+(\d{4})', name, re.IGNORECASE)
    if not year_match:
        year_match = re.search(r'(\d{4})\s*[-–]', name)
    year = year_match.group(1) if year_match else ''
    company_match = re.search(r'[-–]\s*(.+)$', name)
    company = company_match.group(1).strip() if company_match else csv_path.stem

    reader = csv.reader(io.StringIO(text), delimiter=';', quotechar='"')
    entries = []
    header_seen = False

    for row in reader:
        if not row or len(row) < 8:
            continue

        # Přeskoč hlavičku
        if not header_seen:
            if 'Finanční úřad' in row[0] or 'Datum' in row[5]:
                header_seen = True
                continue
            # Pokud hlavička chybí, zkus rozpoznat datový řádek
            if not re.match(r'\d{1,2}\.\d{1,2}\.\d{4}', row[5].strip()):
                continue
            header_seen = True

        datum = row[5].strip()
        if not datum or not re.match(r'\d{1,2}\.\d{1,2}\.\d{4}', datum):
            continue

        entries.append(PMDEntry(
            financni_urad=row[0].strip(),
            uzemni_pracoviste=row[1].strip(),
            druh_prijmu=row[2].strip(),
            platcova_pokladna=row[3].strip(),
            popis=row[4].strip(),
            datum=datum,
            ma_dati=_parse_pmd_amount(row[6]),
            dal=_parse_pmd_amount(row[7]),
        ))

    # Seřadit chronologicky
    entries.sort(key=lambda e: e.datum_sort)

    return PMDReport(company=company, year=year, entries=entries)


# ---------------------------------------------------------------------------
# Rozvaha Parser
# ---------------------------------------------------------------------------

def _split_cz_accounting_numbers(nums_str: str, expected_cols: int = 0) -> list[Decimal]:
    """
    Rozdělí řetězec účetních čísel na jednotlivé hodnoty.

    České účetní výkazy v tisících Kč — hodnoty typicky do stovek tisíc.
    Formát: mezera jako tisícový oddělovač (62 842 = 62842).
    Záporná čísla: -2 923.

    Strategie: tokenizuj řetězec po jednotlivých slovech (skupinách číslic)
    a seskupuj je do čísel. Skupina se připojí k předchozímu číslu pouze
    pokud má přesně 3 cifry a předchozí skupiny nemají mezeru za sebou
    následovanou číslem, které má <= 3 cifry (= začátek nového čísla).

    Protože tato heuristika selhává u ambiguozních případů (622 612 = jedno
    nebo dvě čísla?), používáme znalost formátu: rozumná maximální hodnota
    pro malé s.r.o. v tis. Kč je ~200 000. Cokoliv nad 200 000 je
    pravděpodobně sloučení dvou hodnot.
    """
    nums_str = nums_str.strip()
    if not nums_str:
        return []

    # Extrahuj všechna slova (skupiny číslic, případně s minus)
    # a rekonstruuj čísla konzervativně — každá skupina číslic s 1-3 ciframi
    # začíná nové číslo, skupiny s přesně 3 ciframi se MOHOU připojit
    # k předchozímu. Rozhodujeme podle MAX_REASONABLE.
    MAX_REASONABLE = Decimal(200_000)

    # Najdi všechny číselné tokeny (slova)
    word_pattern = re.compile(r'-?\d+')
    words = word_pattern.findall(nums_str)
    if not words:
        return []

    # Seskup slova do čísel
    results: list[Decimal] = []
    current_parts: list[str] = []

    for w in words:
        is_negative = w.startswith('-')
        digits = w.lstrip('-')

        if not current_parts:
            # Začátek nového čísla
            current_parts = [w]
            continue

        # Může se toto slovo připojit k aktuálnímu číslu?
        # Podmínky: přesně 3 cifry, bez minus, výsledek by byl rozumný
        if len(digits) == 3 and not is_negative:
            candidate = ''.join(p.lstrip('-') if i == 0 else p for i, p in enumerate(current_parts)) + digits
            if current_parts[0].startswith('-'):
                candidate = '-' + candidate
            try:
                cval = Decimal(candidate)
            except InvalidOperation:
                cval = None

            if cval is not None and abs(cval) <= MAX_REASONABLE:
                current_parts.append(w)
                continue

        # Nemůže se připojit — uzavři aktuální číslo a začni nové
        raw = ''.join(p.lstrip('-') if i > 0 else p.replace('-', '') for i, p in enumerate(current_parts))
        if current_parts[0].startswith('-'):
            raw = '-' + raw
        try:
            results.append(Decimal(raw))
        except InvalidOperation:
            pass
        current_parts = [w]

    # Uzavři poslední číslo
    if current_parts:
        raw = ''.join(p.lstrip('-') if i > 0 else p.replace('-', '') for i, p in enumerate(current_parts))
        if current_parts[0].startswith('-'):
            raw = '-' + raw
        try:
            results.append(Decimal(raw))
        except InvalidOperation:
            pass

    return results


def _extract_line_values(text_lines: list[str], identifier: str, row_num: str,
                         expected_cols: int = 0) -> list[Decimal]:
    """Najde řádek v textu podle identifikátoru + čísla řádku a extrahuje účetní čísla."""
    for line in text_lines:
        if identifier in line and row_num in line:
            idx = line.find(row_num)
            if idx >= 0:
                after = line[idx + len(row_num):]
                return _split_cz_accounting_numbers(after, expected_cols)
    return []


def parse_rozvaha(pdf_path: Path) -> RozvahaData:
    """
    Parsuje Rozvahu v plném rozsahu z PDF.
    Formát: Ježek software DUEL, vyhláška č. 500/2002 Sb.
    Jednotky typicky 1000 Kč.

    Extrahuje klíčové řádky pomocí regex na označení + číslo řádku.
    """
    text = parse_pdf_text(pdf_path)

    # Metadata
    company_m = re.search(
        r'(Baker estates|Pinehill|PineHouse|PineInvest|PineAir)\s+s\.r\.o\.',
        text, re.IGNORECASE
    )
    year_m = re.search(r'ke dni\s*\n?\s*(\d{2}\.\d{2}\.)?(\d{4})', text)
    units_m = re.search(r'jednotky:\s*([\d\s]+Kč)', text)

    company = company_m.group(1) if company_m else pdf_path.stem
    year = year_m.group(2) if year_m else ''
    units = units_m.group(1).strip() if units_m else '1000 Kč'

    data = RozvahaData(company=company, year=year, units=units, raw_text=text)
    lines = text.splitlines()

    # Aktiva: 4 sloupce (Brutto, Korekce, Netto běžné, Netto minulé)
    # Když Korekce = 0, PDF ji vynechá → 3 sloupce (Brutto=Netto, Netto, Minulé)
    # Netto běžné = předposlední hodnota (index -2)
    def _aktiva_netto(vals: list[Decimal]) -> Optional[Decimal]:
        if len(vals) >= 2:
            return vals[-2]
        elif len(vals) == 1:
            return vals[0]
        return None

    vals = _extract_line_values(lines, 'AKTIVA CELKEM', '001')
    data.aktiva_celkem = _aktiva_netto(vals)

    vals = _extract_line_values(lines, 'Stálá aktiva', '003')
    data.stala_aktiva = _aktiva_netto(vals)

    vals = _extract_line_values(lines, 'Oběžná aktiva', '037')
    data.obezna_aktiva = _aktiva_netto(vals)

    vals = _extract_line_values(lines, 'Peněžní prostředky', '071')
    data.penezni_prostredky = _aktiva_netto(vals)

    vals = _extract_line_values(lines, 'Pohledávky', '046')
    data.pohledavky = _aktiva_netto(vals)

    vals = _extract_line_values(lines, 'Časové rozlišení aktiv', '074')
    data.casove_rozliseni_aktiv = _aktiva_netto(vals)

    # Pasiva: 2 sloupce (běžné, minulé)
    vals = _extract_line_values(lines, 'PASIVA CELKEM', '078', expected_cols=2)
    if vals:
        data.pasiva_celkem = vals[0]

    vals = _extract_line_values(lines, 'Vlastní kapitál', '079', expected_cols=2)
    if vals:
        data.vlastni_kapital = vals[0]

    vals = _extract_line_values(lines, 'Základní kapitál', '080', expected_cols=2)
    if vals:
        data.zakladni_kapital = vals[0]

    vals = _extract_line_values(lines, 'běžného účetního období', '098', expected_cols=2)
    if vals:
        data.vsledek_hospodareni_bezne = vals[0]

    vals = _extract_line_values(lines, 'minulých let', '095', expected_cols=2)
    if vals:
        data.vsledek_hospodareni_minule = vals[0]

    vals = _extract_line_values(lines, 'Cizí zdroje', '100', expected_cols=2)
    if vals:
        data.cizi_zdroje = vals[0]

    return data


# ---------------------------------------------------------------------------
# VZZ Parser
# ---------------------------------------------------------------------------

def parse_vzz(pdf_path: Path) -> VZZData:
    """
    Parsuje Výkaz zisku a ztráty v plném rozsahu z PDF.
    Formát: Ježek software DUEL, vyhláška č. 500/2002 Sb.
    Jednotky typicky 1000 Kč.
    """
    text = parse_pdf_text(pdf_path)

    company_m = re.search(
        r'(Baker estates|Pinehill|PineHouse|PineInvest|PineAir)\s+s\.r\.o\.',
        text, re.IGNORECASE
    )
    year_m = re.search(r'ke dni\s*\n?\s*(\d{2}\.\d{2}\.)?(\d{4})', text)
    units_m = re.search(r'jednotky:\s*([\d\s]+Kč)', text)

    company = company_m.group(1) if company_m else pdf_path.stem
    year = year_m.group(2) if year_m else ''
    units = units_m.group(1).strip() if units_m else '1000 Kč'

    data = VZZData(company=company, year=year, units=units, raw_text=text)

    # VZZ má 2 sloupce: sledované období, minulé období
    lines = text.splitlines()

    vals = _extract_line_values(lines, 'Tržby z prodeje výrobků a služeb', '001', expected_cols=2)
    if vals:
        data.trzby_vyrobky_sluzby = vals[0]

    vals = _extract_line_values(lines, 'Výkonová spotřeba', '003', expected_cols=2)
    if vals:
        data.vykonova_spotreba = vals[0]

    vals = _extract_line_values(lines, 'Osobní náklady', '009', expected_cols=2)
    if vals:
        data.osobni_naklady = vals[0]

    vals = _extract_line_values(lines, 'Úpravy hodnot v provozní oblasti', '014', expected_cols=2)
    if vals:
        data.odpisy = vals[0]

    vals = _extract_line_values(lines, 'Provozní výsledek hospodaření', '030', expected_cols=2)
    if vals:
        data.provozni_vysledek = vals[0]

    vals = _extract_line_values(lines, 'Finanční výsledek hospodaření', '048', expected_cols=2)
    if vals:
        data.financni_vysledek = vals[0]

    vals = _extract_line_values(lines, 'Výsledek hospodaření před zdaněním', '049', expected_cols=2)
    if vals:
        data.vysledek_pred_zdanenim = vals[0]

    # Daň z příjmů — ř. 050, ale NE 051 (splatná)
    for line in lines:
        if 'Daň z příjmů' in line and '050' in line and '051' not in line:
            idx = line.find('050')
            if idx >= 0:
                nums = _split_cz_accounting_numbers(line[idx + 3:], expected_cols=2)
                if nums:
                    data.dan_z_prijmu = nums[0]
            break

    vals = _extract_line_values(lines, 'Výsledek hospodaření po zdanění', '053', expected_cols=2)
    if vals:
        data.vysledek_po_zdaneni = vals[0]

    vals = _extract_line_values(lines, 'Čistý obrat za účetní období', '056', expected_cols=2)
    if vals:
        data.cisty_obrat = vals[0]

    vals = _extract_line_values(lines, 'Nákladové úroky a podobné náklady', '043', expected_cols=2)
    if vals:
        data.nakladove_uroky = vals[0]

    return data


# ---------------------------------------------------------------------------
# DPPO Parser
# ---------------------------------------------------------------------------

def parse_dppo(pdf_path: Path) -> DPPOData:
    """
    Parsuje DPPO přiznání z PDF.
    Extrahuje klíčové řádky II. oddílu.
    """
    text = parse_pdf_text(pdf_path)

    company_m = re.search(
        r'(Baker estates|Pinehill|PineHouse|PineInvest|PineAir)\s+s\.r\.o\.',
        text, re.IGNORECASE
    )
    year_m = re.search(r'(\d{2})\s*(\d{2})\s*(\d{4})\s*$', text[:500], re.MULTILINE)
    ico_m = re.search(r'Identifikační číslo.*?(\d{8})', text[:1000], re.DOTALL)
    dic_m = re.search(r'Daňové identifikační číslo.*?CZ\s*(\d{8})', text[:1000], re.DOTALL)

    company = company_m.group(1) if company_m else pdf_path.stem
    year = ''
    if year_m:
        year = year_m.group(3)
    else:
        # Zkus z názvu souboru
        ym = re.search(r'(\d{4})', pdf_path.stem)
        if ym:
            year = ym.group(1)

    ico = ico_m.group(1) if ico_m else ''
    dic = f"CZ{dic_m.group(1)}" if dic_m else ''

    data = DPPOData(company=company, year=year, ico=ico, dic=dic, raw_text=text)

    # Parsování řádků II. oddílu — hodnoty v celých Kč
    # Vzor: "10" + text + číslo (může být záporné s minus na konci)
    def find_dppo_value(pattern: str) -> Optional[Decimal]:
        m = re.search(pattern, text)
        if m:
            val_str = m.group(1).strip()
            # DPPO může mít záporné hodnoty jako "-1 859 797"
            return _parse_amount(val_str)
        return None

    # ř. 10 — VH
    data.vysledek_hospodareni = find_dppo_value(
        r'ke dni.*?(-?[\d\s]+)'
    )
    # Zkus přesnější pattern
    if data.vysledek_hospodareni is None:
        m = re.search(r'108\).*?(-?[\d\s]+(?:\s\d{3})*)', text)
        if m:
            data.vysledek_hospodareni = _parse_amount(m.group(1))

    # ř. 40 — Neuznané náklady
    m = re.search(r'40\s+a udržení příjmů.*?(-?[\d\s]+(?:\s\d{3})*)', text)
    if m:
        data.neuznane_naklady = _parse_amount(m.group(1))

    # ř. 200/220 — základ daně
    m = re.search(r'(?:200|220)\s+.*?základ.*?(-?[\d\s]+)', text)
    if m:
        data.zaklad_dane = _parse_amount(m.group(1))

    # ř. 290 — daň
    m = re.search(r'290\s+.*?(-?[\d\s]+)', text)
    if m:
        data.dan = _parse_amount(m.group(1))

    return data


# ---------------------------------------------------------------------------
# File Discovery
# ---------------------------------------------------------------------------

def find_pmd_files(company: str, year: str) -> list[Path]:
    """Najde PMD CSV soubory pro firmu a rok."""
    local_year = _local_accounting_path(company, year)
    if local_year:
        files = []
        for p in sorted(local_year.rglob('*')):
            if p.is_file() and p.suffix.lower() == '.csv' and 'pohyby' in p.name.lower():
                files.append(p)
        return files
    return []


def find_dppo_folder(company: str, year: str) -> Optional[Path]:
    """Najde DPPO složku pro firmu a rok."""
    local_year = _local_accounting_path(company, year)
    if local_year:
        for d in sorted(local_year.iterdir()):
            if d.is_dir() and 'dppo' in d.name.lower():
                return d
    return None


def find_rozvaha(company: str, year: str) -> Optional[Path]:
    """Najde PDF s rozvahou."""
    dppo_dir = find_dppo_folder(company, year)
    if dppo_dir:
        for p in sorted(dppo_dir.iterdir()):
            if p.suffix.lower() == '.pdf' and 'rozvaha' in p.name.lower():
                return p
    return None


def find_vzz(company: str, year: str) -> Optional[Path]:
    """Najde PDF s výkazem zisku a ztráty."""
    dppo_dir = find_dppo_folder(company, year)
    if dppo_dir:
        for p in sorted(dppo_dir.iterdir()):
            if p.suffix.lower() == '.pdf' and 'zisku' in p.name.lower():
                return p
    return None


def find_dppo_pdf(company: str, year: str) -> Optional[Path]:
    """Najde PDF s DPPO přiznáním (ne dodejku, ne převodní příkaz)."""
    dppo_dir = find_dppo_folder(company, year)
    if dppo_dir:
        for p in sorted(dppo_dir.iterdir()):
            name_lower = p.name.lower()
            if (p.suffix.lower() == '.pdf'
                    and 'dppo' in name_lower
                    and 'dodejka' not in name_lower
                    and 'převodní' not in name_lower
                    and 'prevodní' not in name_lower
                    and 'převodní' not in name_lower
                    and 'qr' not in name_lower
                    and 'rozpis' not in name_lower):
                return p
    return None


# ---------------------------------------------------------------------------
# Formátování výstupů
# ---------------------------------------------------------------------------

def fmt_czk(amount, units: str = '') -> str:
    """Formátuje částku v CZK."""
    if amount is None:
        return '—'
    val = float(amount)
    suffix = ''
    if '1000' in units or '1 000' in units:
        suffix = ' tis.'
    return f"{val:,.0f} Kč{suffix}".replace(',', '\xa0')


def format_pmd_summary(report: PMDReport) -> str:
    """Formátuje shrnutí PMD reportu jako text."""
    lines = [
        f"POHYBY NA DAŇOVÉM ÚČTU — {report.company} ({report.year})",
        f"{'=' * 60}",
        f"Celkem zaplaceno:  {fmt_czk(report.total_paid)}",
        f"Celkem vráceno:    {fmt_czk(report.total_received)}",
        f"Čistý odvod:       {fmt_czk(report.net)}",
        f"Počet záznamů:     {len(report.entries)}",
        "",
        "ROZPAD PODLE TYPU DANĚ:",
    ]

    for tax_type, entries in report.by_tax_type().items():
        paid = sum((e.ma_dati for e in entries if e.ma_dati), Decimal(0))
        received = sum((e.dal for e in entries if e.dal), Decimal(0))
        lines.append(f"  {tax_type}:")
        lines.append(f"    Zaplaceno: {fmt_czk(paid)}  |  Vráceno: {fmt_czk(received)}  |  Netto: {fmt_czk(paid - received)}")

    lines.append("")
    lines.append("MĚSÍČNÍ PŘEHLED:")
    for month_key, entries in report.by_month().items():
        paid = sum((e.ma_dati for e in entries if e.ma_dati), Decimal(0))
        received = sum((e.dal for e in entries if e.dal), Decimal(0))
        lines.append(f"  {month_key}: zaplaceno {fmt_czk(paid)}, vráceno {fmt_czk(received)}")

    lines.append("")
    lines.append("DETAIL POHYBŮ:")
    for e in report.entries:
        direction = "→" if e.ma_dati else "←"
        amt = fmt_czk(e.ma_dati or e.dal)
        lines.append(f"  {e.datum}  {direction} {amt:>20}  {e.popis}  ({e.druh_prijmu})")

    return '\n'.join(lines)


def format_rozvaha_summary(data: RozvahaData) -> str:
    """Formátuje shrnutí rozvahy."""
    u = data.units
    lines = [
        f"ROZVAHA — {data.company} ({data.year})",
        f"Jednotky: {u}",
        f"{'=' * 60}",
        "",
        "AKTIVA:",
        f"  Aktiva celkem:           {fmt_czk(data.aktiva_celkem, u)}",
        f"  Stálá aktiva:            {fmt_czk(data.stala_aktiva, u)}",
        f"  Oběžná aktiva:           {fmt_czk(data.obezna_aktiva, u)}",
        f"    Pohledávky:            {fmt_czk(data.pohledavky, u)}",
        f"    Peněžní prostředky:    {fmt_czk(data.penezni_prostredky, u)}",
        f"  Časové rozlišení:        {fmt_czk(data.casove_rozliseni_aktiv, u)}",
        "",
        "PASIVA:",
        f"  Pasiva celkem:           {fmt_czk(data.pasiva_celkem, u)}",
        f"  Vlastní kapitál:         {fmt_czk(data.vlastni_kapital, u)}",
        f"    Základní kapitál:      {fmt_czk(data.zakladni_kapital, u)}",
        f"    VH běžné období:       {fmt_czk(data.vsledek_hospodareni_bezne, u)}",
        f"    VH minulých let:       {fmt_czk(data.vsledek_hospodareni_minule, u)}",
        f"  Cizí zdroje:             {fmt_czk(data.cizi_zdroje, u)}",
    ]
    return '\n'.join(lines)


def format_vzz_summary(data: VZZData) -> str:
    """Formátuje shrnutí VZZ."""
    u = data.units
    lines = [
        f"VÝKAZ ZISKU A ZTRÁTY — {data.company} ({data.year})",
        f"Jednotky: {u}",
        f"{'=' * 60}",
        "",
        f"  Tržby z prodeje výrobků a služeb:  {fmt_czk(data.trzby_vyrobky_sluzby, u)}",
        f"  Výkonová spotřeba:                 {fmt_czk(data.vykonova_spotreba, u)}",
        f"  Osobní náklady:                    {fmt_czk(data.osobni_naklady, u)}",
        f"  Odpisy (úpravy hodnot):            {fmt_czk(data.odpisy, u)}",
        f"  {'─' * 45}",
        f"  Provozní VH:                       {fmt_czk(data.provozni_vysledek, u)}",
        f"  Nákladové úroky:                   {fmt_czk(data.nakladove_uroky, u)}",
        f"  Finanční VH:                       {fmt_czk(data.financni_vysledek, u)}",
        f"  {'─' * 45}",
        f"  VH před zdaněním:                  {fmt_czk(data.vysledek_pred_zdanenim, u)}",
        f"  Daň z příjmů:                      {fmt_czk(data.dan_z_prijmu, u)}",
        f"  VH po zdanění:                     {fmt_czk(data.vysledek_po_zdaneni, u)}",
        f"  {'═' * 45}",
        f"  Čistý obrat:                       {fmt_czk(data.cisty_obrat, u)}",
    ]
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Analytické funkce (s Ollama)
# ---------------------------------------------------------------------------

def analyze_pmd(report: PMDReport, question: str = '') -> str:
    """Analyzuje PMD report pomocí Ollama."""
    context = format_pmd_summary(report)
    prompt = f"{context}\n\n---\n"
    if question:
        prompt += f"Otázka: {question}"
    else:
        prompt += (
            "Proveď analýzu pohybů na daňovém účtu:\n"
            "1. Shrň celkové daňové zatížení firmy\n"
            "2. Rozlož podle typu daně (DPH, DPPO, ...)\n"
            "3. Identifikuj neobvyklé položky nebo nesrovnalosti\n"
            "4. Porovnej zálohy vs. doplatky\n"
            "Buď stručný, uváděj konkrétní čísla."
        )
    llm = LLMClient(backend='ollama')
    return llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT)


def analyze_annual_reports(company: str, year: str, question: str = '') -> str:
    """Analyzuje roční výkazy (rozvaha + VZZ + DPPO) pomocí Ollama."""
    parts = []

    rozvaha_path = find_rozvaha(company, year)
    if rozvaha_path:
        try:
            rozvaha = parse_rozvaha(rozvaha_path)
            parts.append(format_rozvaha_summary(rozvaha))
        except Exception as e:
            parts.append(f"Rozvaha: chyba parsování — {e}")

    vzz_path = find_vzz(company, year)
    if vzz_path:
        try:
            vzz = parse_vzz(vzz_path)
            parts.append(format_vzz_summary(vzz))
        except Exception as e:
            parts.append(f"VZZ: chyba parsování — {e}")

    dppo_path = find_dppo_pdf(company, year)
    if dppo_path:
        try:
            dppo = parse_dppo(dppo_path)
            parts.append(f"DPPO — {dppo.company} ({dppo.year})\nIČO: {dppo.ico}")
            if dppo.vysledek_hospodareni:
                parts.append(f"  VH (ř. 10): {fmt_czk(dppo.vysledek_hospodareni)}")
            if dppo.neuznane_naklady:
                parts.append(f"  Neuznané náklady (ř. 40): {fmt_czk(dppo.neuznane_naklady)}")
        except Exception as e:
            parts.append(f"DPPO: chyba parsování — {e}")

    if not parts:
        return f"Žádné roční výkazy nenalezeny pro {company} {year}"

    context = '\n\n'.join(parts)
    prompt = f"{context}\n\n---\n"
    if question:
        prompt += f"Otázka: {question}"
    else:
        prompt += (
            "Proveď komplexní analýzu ročních výkazů:\n"
            "1. Zhodnoť finanční zdraví firmy (likvidita, zadluženost)\n"
            "2. Zhodnoť ziskovost a rentabilitu\n"
            "3. Porovnej s minulým obdobím (pokud data dostupná)\n"
            "4. Identifikuj rizika a příležitosti\n"
            "Buď stručný a konkrétní."
        )
    llm = LLMClient(backend='ollama')
    return llm.complete(prompt, system=FINANCE_SYSTEM_PROMPT)


# ---------------------------------------------------------------------------
# CLI dispatcher
# ---------------------------------------------------------------------------

def run_pmd(company: str, year: str, question: str = '') -> str:
    """Spustí analýzu PMD exportu."""
    files = find_pmd_files(company, year)
    if not files:
        return f"Žádné PMD soubory nenalezeny pro {company} {year}"

    results = []
    for f in files:
        try:
            report = parse_pmd_csv(f)
            summary = format_pmd_summary(report)
            if question:
                analysis = analyze_pmd(report, question)
                results.append(f"{summary}\n\n--- ANALÝZA ---\n{analysis}")
            else:
                results.append(summary)
        except Exception as e:
            results.append(f"Chyba při parsování {f.name}: {e}")

    return '\n\n'.join(results)


def run_annual(company: str, year: str, question: str = '') -> str:
    """Spustí analýzu ročních výkazů."""
    parts = []

    # Rozvaha
    rozvaha_path = find_rozvaha(company, year)
    if rozvaha_path:
        try:
            rozvaha = parse_rozvaha(rozvaha_path)
            parts.append(format_rozvaha_summary(rozvaha))
        except Exception as e:
            parts.append(f"Rozvaha: chyba — {e}")

    # VZZ
    vzz_path = find_vzz(company, year)
    if vzz_path:
        try:
            vzz = parse_vzz(vzz_path)
            parts.append(format_vzz_summary(vzz))
        except Exception as e:
            parts.append(f"VZZ: chyba — {e}")

    if not parts:
        return f"Žádné roční výkazy nenalezeny pro {company} {year}"

    result = '\n\n'.join(parts)

    if question:
        analysis = analyze_annual_reports(company, year, question)
        result += f"\n\n--- ANALÝZA ---\n{analysis}"

    return result


def main():
    """CLI vstupní bod."""
    args = sys.argv[1:]
    if not args:
        print("Použití: accounting.py <akce> <firma> <rok> [otázka]")
        print("Akce: pmd, rozvaha, vzz, výkazy, analýza")
        print("Firmy: baker, pinehill, pinehouse, pineinvest, pineair")
        print()
        print("Příklady:")
        print("  accounting.py pmd baker 2023")
        print("  accounting.py pmd baker 2023 'kolik bylo zaplaceno na DPH?'")
        print("  accounting.py rozvaha baker 2023")
        print("  accounting.py vzz baker 2023")
        print("  accounting.py výkazy baker 2023")
        print("  accounting.py analýza baker 2023 'jak je na tom firma?'")
        sys.exit(0)

    action = args[0].lower()
    company = args[1].lower() if len(args) > 1 else None
    year = args[2] if len(args) > 2 else None
    question = ' '.join(args[3:]) if len(args) > 3 else ''

    if not company or not year:
        print("Chybí firma nebo rok.")
        sys.exit(1)

    if action == 'pmd':
        print(run_pmd(company, year, question))

    elif action in ('rozvaha', 'vzz', 'výkazy', 'vykazy'):
        print(run_annual(company, year, question))

    elif action in ('analýza', 'analyza', 'analysis'):
        # Kompletní analýza — PMD + výkazy
        pmd_result = run_pmd(company, year)
        annual_result = run_annual(company, year)
        context = f"{pmd_result}\n\n{'=' * 60}\n\n{annual_result}"
        if question:
            llm = LLMClient(backend='ollama')
            analysis = llm.complete(
                f"{context}\n\n---\nOtázka: {question}",
                system=FINANCE_SYSTEM_PROMPT
            )
            print(f"{context}\n\n--- ANALÝZA ---\n{analysis}")
        else:
            print(context)

    else:
        print(f"Neznámá akce: {action}")
        sys.exit(1)


if __name__ == '__main__':
    main()
