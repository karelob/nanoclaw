"""
GDrive Finance Downloader
Stahuje finanční dokumenty z Google Drive.
Naviguje po jménech složek (žádné hardcoded folder IDs).
Dva zdroje:
  - Účetnictví Obluk (2025+) — strukturované měsíční složky
  - Business Docs (2013–2024) — historické účetnictví po rocích
Read-only — nikdy nemodifikuje zdrojová data.
"""
import sys
import io
from pathlib import Path
from typing import Optional

# Shared path resolution (container vs host)
sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import TOKEN_FILE, ensure_cone_scripts_importable

ensure_cone_scripts_importable()
import connectors.gdrive as _gdrive_mod
_gdrive_mod.TOKEN_FILE = TOKEN_FILE

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# Only drive IDs are constant (these never change)
DRIVE_UCETNICTVI = '0ANtUxhg1AfrCUk9PVA'   # Účetnictví Obluk
DRIVE_BUSINESS_DOCS = '0AP8QHGiPCrqnUk9PVA'  # Business Docs

# Company name mapping: key → (name on Účetnictví Obluk, name on Business Docs)
COMPANY_NAMES = {
    'baker':     ('Baker Estates', 'Baker estates'),
    'pinehill':  ('Pinehill',      'Pinehill'),
    'pinehouse': ('PineHouse',     'PineHouse'),
    'pineinvest':('PineInvest',    'PineInvest'),
    'pineair':   ('PineAir',       'PineAir'),
}

# Accounting folder names per company on Business Docs
ACCOUNTING_NAMES = {
    'baker':     'Účetnictví Baker',
    'pinehill':  'Účetnictví Pinehill',
    'pinehouse': 'Účetnictví PineHouse',
    'pineinvest':'Účetnictví',
    'pineair':   'Účetnictví PineAir',
}

# Local GDrive sync path (host only — much faster than API)
_GDRIVE_LOCAL = Path.home() / 'Library/CloudStorage/GoogleDrive-karel@obluk.com/Shared drives'
_USE_LOCAL = _GDRIVE_LOCAL.exists()


def _local_accounting_path(company: str, year: str) -> Path | None:
    """Resolve accounting year folder from local GDrive sync. Returns None if not available."""
    if not _USE_LOCAL:
        return None
    key = company.lower()
    _, name_hist = COMPANY_NAMES.get(key, (None, None))
    if not name_hist:
        return None

    # Try Účetnictví Obluk first (2025+)
    y = int(year)
    if y >= 2025:
        name_new = COMPANY_NAMES[key][0]
        p = _GDRIVE_LOCAL / 'Účetnictví Obluk' / name_new / year
        if p.exists():
            return p

    # Business Docs: Company > Finance > Účetnictví > Year
    acct_name = ACCOUNTING_NAMES.get(key, f'Účetnictví {name_hist}')
    p = _GDRIVE_LOCAL / 'Business Docs' / name_hist / 'Finance' / acct_name / year
    if p.exists():
        return p
    return None


def _collect_local_files(folder: Path, extensions: set[str] = {'.pdf', '.csv', '.xlsx', '.xls'}) -> list[Path]:
    """Recursively collect files from local folder."""
    if not folder.exists():
        return []
    files = []
    for p in sorted(folder.rglob('*')):
        if p.is_file() and p.suffix.lower() in extensions:
            files.append(p)
    return files


def _get_service():
    creds = _gdrive_mod._get_credentials()
    return build('drive', 'v3', credentials=creds)

def ls(service, folder_id: str, drive_id: str) -> list:
    """List files/folders in a folder."""
    r = service.files().list(
        q=f"'{folder_id}' in parents and trashed=false",
        driveId=drive_id, corpora='drive',
        includeItemsFromAllDrives=True, supportsAllDrives=True,
        fields='files(id,name,mimeType,size,fileExtension)',
        orderBy='name'
    ).execute()
    return r.get('files', [])

def find_folder(service, parent_id: str, name: str, drive_id: str) -> Optional[str]:
    """Find subfolder by exact name, return id or None."""
    for f in ls(service, parent_id, drive_id):
        if f['name'] == name and 'folder' in f['mimeType']:
            return f['id']
    return None

def find_folder_ci(service, parent_id: str, name: str, drive_id: str) -> Optional[str]:
    """Find subfolder by case-insensitive name."""
    for f in ls(service, parent_id, drive_id):
        if f['name'].lower() == name.lower() and 'folder' in f['mimeType']:
            return f['id']
    return None

def find_folder_contains(service, parent_id: str, keyword: str, drive_id: str) -> Optional[dict]:
    """Find subfolder containing keyword in name."""
    for f in ls(service, parent_id, drive_id):
        if keyword.lower() in f['name'].lower() and 'folder' in f['mimeType']:
            return f
    return None

def download_file(service, file_id: str, dest_path: Path) -> bool:
    """Download file to dest_path. Returns True on success."""
    buf = io.BytesIO()
    req = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(buf.getvalue())
    return True

def _collect_pdfs(service, folder_id: str, drive_id: str,
                  cache_dir: Path, prefix_parts: list[str]) -> list[Path]:
    """Recursively collect PDF files from a folder tree."""
    pdf_files = []
    for f in ls(service, folder_id, drive_id):
        if 'folder' in f['mimeType']:
            pdf_files.extend(_collect_pdfs(
                service, f['id'], drive_id, cache_dir, prefix_parts + [f['name']]))
        elif f.get('fileExtension', '').lower() in ('pdf', 'csv', 'xlsx', 'xls'):
            dest = cache_dir / '/'.join(prefix_parts) / f['name']
            if not dest.exists():
                download_file(service, f['id'], dest)
            pdf_files.append(dest)
    return pdf_files

def _navigate_to_accounting(service, company: str, year: str):
    """
    Navigate to the accounting year folder.
    Returns (drive_id, year_folder_id) or raises FileNotFoundError.
    Tries Účetnictví Obluk first (2025+), then Business Docs.
    """
    key = company.lower()
    if key not in COMPANY_NAMES:
        raise ValueError(f"Neznámá firma: {company}. Dostupné: {list(COMPANY_NAMES.keys())}")

    name_new, name_hist = COMPANY_NAMES[key]
    y = int(year)

    # Try Účetnictví Obluk first (for 2025+)
    if y >= 2025:
        comp_id = find_folder_ci(service, DRIVE_UCETNICTVI, name_new, DRIVE_UCETNICTVI)
        if comp_id:
            year_id = find_folder(service, comp_id, year, DRIVE_UCETNICTVI)
            if year_id:
                return DRIVE_UCETNICTVI, year_id

    # Business Docs: Company > Finance > Účetnictví > Year
    comp_id = find_folder_ci(service, DRIVE_BUSINESS_DOCS, name_hist, DRIVE_BUSINESS_DOCS)
    if not comp_id:
        raise FileNotFoundError(f"Firma {company} nenalezena na žádném drive")

    fin_id = find_folder(service, comp_id, 'Finance', DRIVE_BUSINESS_DOCS)
    if not fin_id:
        raise FileNotFoundError(f"Složka Finance nenalezena pro {company}")

    acct_name = ACCOUNTING_NAMES.get(key, f'Účetnictví {name_hist}')
    acct_id = find_folder(service, fin_id, acct_name, DRIVE_BUSINESS_DOCS)
    if not acct_id:
        # Try fuzzy match
        acct_folder = find_folder_contains(service, fin_id, 'účetnictví', DRIVE_BUSINESS_DOCS)
        if acct_folder:
            acct_id = acct_folder['id']
    if not acct_id:
        raise FileNotFoundError(f"Účetnictví nenalezena pro {company}")

    year_id = find_folder(service, acct_id, year, DRIVE_BUSINESS_DOCS)
    if not year_id:
        raise FileNotFoundError(f"Rok {year} nenalezen pro {company}")

    return DRIVE_BUSINESS_DOCS, year_id


def get_bank_statements(company: str, year: str, month: str,
                        cache_dir: Path = Path('/tmp/finance_cache')) -> list[Path]:
    """
    Stáhne bankovní výpisy pro danou firmu, rok a měsíc.
    Vrátí seznam stažených souborů.
    Preferuje lokální GDrive sync (host), fallback na API (kontejner).
    """
    # Try local filesystem first (instant, no API calls)
    local_year = _local_accounting_path(company, year)
    if local_year:
        # New format: year > YYYYMM > Výpisy/
        month_dir = local_year / f"{year}{month}"
        if month_dir.exists():
            import unicodedata
            for sub in sorted(month_dir.iterdir()):
                # Normalize NFD→NFC (macOS stores filenames in NFD)
                sub_nfc = unicodedata.normalize('NFC', sub.name).lower()
                if sub.is_dir() and 'výpis' in sub_nfc:
                    return _collect_local_files(sub)
            # No výpisy subfolder — return all from month
            return _collect_local_files(month_dir)
        # Historical format: files directly in year folder or month subfolder
        return _collect_local_files(local_year / f"{year}_{month}") or _collect_local_files(local_year)

    # Fallback: GDrive API
    service = _get_service()
    drive_id, year_folder = _navigate_to_accounting(service, company, year)

    month_folder = find_folder(service, year_folder, f"{year}{month}", drive_id)
    if month_folder:
        vyp_folder = find_folder_contains(service, month_folder, 'výpis', drive_id)
        if vyp_folder:
            return _collect_pdfs(service, vyp_folder['id'], drive_id,
                                cache_dir, [company, year, month, 'výpisy'])

    return _collect_pdfs(service, year_folder, drive_id,
                         cache_dir, [company, year, month])


def get_invoices(company: str, year: str, month: str, direction: str = 'both',
                 cache_dir: Path = Path('/tmp/finance_cache')) -> list[Path]:
    """
    Stáhne faktury pro danou firmu, rok a měsíc.
    direction: 'received' | 'issued' | 'both'
    """
    keywords = []
    if direction in ('received', 'both'):
        keywords.append('přijaté')
    if direction in ('issued', 'both'):
        keywords.append('vydané')
    if not keywords:
        keywords.append('faktur')

    # Try local filesystem first
    local_year = _local_accounting_path(company, year)
    if local_year:
        month_dir = local_year / f"{year}{month}"
        search_dir = month_dir if month_dir.exists() else local_year
        pdf_files = []
        for kw in keywords:
            for sub in sorted(search_dir.iterdir()) if search_dir.exists() else []:
                if sub.is_dir() and kw.lower() in sub.name.lower():
                    pdf_files.extend(_collect_local_files(sub))
        return pdf_files

    # Fallback: GDrive API
    service = _get_service()
    drive_id, year_folder = _navigate_to_accounting(service, company, year)

    month_folder = find_folder(service, year_folder, f"{year}{month}", drive_id)
    if not month_folder:
        month_folder = year_folder

    pdf_files = []
    for kw in keywords:
        folder = find_folder_contains(service, month_folder, kw, drive_id)
        if folder:
            pdf_files.extend(_collect_pdfs(
                service, folder['id'], drive_id,
                cache_dir, [company, year, month, 'faktury', kw]))

    return pdf_files


def list_available_years(company: str) -> dict[str, list[str]]:
    """List available years for a company across both drives."""
    key = company.lower()
    if key not in COMPANY_NAMES:
        raise ValueError(f"Neznámá firma: {company}")

    name_new, name_hist = COMPANY_NAMES[key]
    result = {}

    if _USE_LOCAL:
        # Fast: scan local filesystem
        p = _GDRIVE_LOCAL / 'Účetnictví Obluk' / name_new
        if p.exists():
            years = sorted(d.name for d in p.iterdir() if d.is_dir() and d.name.isdigit())
            if years:
                result['Účetnictví Obluk'] = years

        acct_name = ACCOUNTING_NAMES.get(key, f'Účetnictví {name_hist}')
        p = _GDRIVE_LOCAL / 'Business Docs' / name_hist / 'Finance' / acct_name
        if p.exists():
            years = sorted(d.name for d in p.iterdir() if d.is_dir() and d.name.isdigit())
            if years:
                result['Business Docs'] = years
        return result

    # Fallback: GDrive API
    service = _get_service()

    comp_id = find_folder_ci(service, DRIVE_UCETNICTVI, name_new, DRIVE_UCETNICTVI)
    if comp_id:
        years = [f['name'] for f in ls(service, comp_id, DRIVE_UCETNICTVI)
                 if 'folder' in f['mimeType'] and f['name'].isdigit()]
        if years:
            result['Účetnictví Obluk'] = sorted(years)

    comp_id = find_folder_ci(service, DRIVE_BUSINESS_DOCS, name_hist, DRIVE_BUSINESS_DOCS)
    if comp_id:
        fin_id = find_folder(service, comp_id, 'Finance', DRIVE_BUSINESS_DOCS)
        if fin_id:
            acct_name = ACCOUNTING_NAMES.get(key, f'Účetnictví {name_hist}')
            acct_id = find_folder(service, fin_id, acct_name, DRIVE_BUSINESS_DOCS)
            if not acct_id:
                acct_folder = find_folder_contains(service, fin_id, 'účetnictví', DRIVE_BUSINESS_DOCS)
                if acct_folder:
                    acct_id = acct_folder['id']
            if acct_id:
                years = [f['name'] for f in ls(service, acct_id, DRIVE_BUSINESS_DOCS)
                         if 'folder' in f['mimeType'] and f['name'].isdigit()]
                if years:
                    result['Business Docs'] = sorted(years)

    return result


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        company = sys.argv[1]
        years = list_available_years(company)
        print(f"Dostupné roky pro {company}:")
        for drive, yrs in years.items():
            print(f"  {drive}: {', '.join(yrs)}")
    else:
        print("Použití: python3 gdrive_finance.py <firma>")
        print("Firmy:", ', '.join(COMPANY_NAMES.keys()))
