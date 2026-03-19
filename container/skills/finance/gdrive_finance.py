"""
GDrive Finance Downloader
Stahuje finanční dokumenty z Google Drive.
Dva zdroje:
  - Účetnictví Obluk (2025+) — strukturované měsíční složky
  - Business Docs (2013–2024) — historické účetnictví po rocích
Read-only — nikdy nemodifikuje zdrojová data.
"""
import sys
import io
import json
from pathlib import Path
from typing import Optional

sys.path.insert(0, '/workspace/extra/cone-scripts')

# Setup credentials
import connectors.gdrive as _gdrive_mod
_gdrive_mod.TOKEN_FILE = Path('/workspace/extra/cone-config/token.json')

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# Shared drive: Účetnictví Obluk (2025+, structured monthly)
DRIVE_UCETNICTVI = '0ANtUxhg1AfrCUk9PVA'
COMPANY_FOLDERS_NEW = {
    'baker':     '1fIf_kPTPggxw_KJwiMEfClabO_b1Gw35',
    'pinehill':  '1LqkTy7RV-umhlU_lJRMwmKtFy7AjfN1w',
    'pinehouse': '1gVluMW-KRGkdwlkxBAp3-QDsbgXVlhzG',
    'pineinvest':'1Jir9F5CO0v6MxZARy8Fmkxapd3MbV2-8',
    'pineair':   '1TdatGQksDHSDW7qTU2v6DFNo8OXe8ftk',
}

# Shared drive: Business Docs (2013–2024, historical accounting)
DRIVE_BUSINESS_DOCS = '0AP8QHGiPCrqnUk9PVA'
COMPANY_FOLDERS_HIST = {
    'baker':     '1ZFK14C-LTDaTV0_rgtL6NETujOdggQrC',
    'pinehill':  '1tXR2Qa-Wr4PkDe4i3XHzUiZQfcv6VJgs',
    'pinehouse': '17MEMg3e89NqBzThn9nGWigswOo4srCsE',
    'pineinvest':'1062-pGpBZpT30pr9Yxw2rQNuN__pN89l',
    'pineair':   '1CEKLFKubaVtDaL2j7-T6s87O-e_doh9R',
}

def _resolve_company(company: str, year: str):
    """Return (drive_id, folder_id) based on year — new drive for 2025+, historical for older."""
    y = int(year)
    if y >= 2025 and company.lower() in COMPANY_FOLDERS_NEW:
        return DRIVE_UCETNICTVI, COMPANY_FOLDERS_NEW[company.lower()]
    if company.lower() in COMPANY_FOLDERS_HIST:
        return DRIVE_BUSINESS_DOCS, COMPANY_FOLDERS_HIST[company.lower()]
    raise ValueError(f"Neznámá firma: {company}")

# Keep backward compat
DRIVE_ID = DRIVE_UCETNICTVI
COMPANY_FOLDERS = COMPANY_FOLDERS_NEW

def _get_service():
    creds = _gdrive_mod._get_credentials()
    return build('drive', 'v3', credentials=creds)

def ls(service, folder_id: str, drive_id: str = DRIVE_UCETNICTVI) -> list:
    """List files in folder."""
    r = service.files().list(
        q=f"'{folder_id}' in parents",
        driveId=drive_id, corpora='drive',
        includeItemsFromAllDrives=True, supportsAllDrives=True,
        fields='files(id,name,mimeType,size,fileExtension)',
        orderBy='name'
    ).execute()
    return r.get('files', [])

def find_folder(service, parent_id: str, name: str, drive_id: str = DRIVE_UCETNICTVI) -> Optional[str]:
    """Find subfolder by name, return id or None."""
    for f in ls(service, parent_id, drive_id):
        if f['name'] == name and 'folder' in f['mimeType']:
            return f['id']
    return None

def find_folder_contains(service, parent_id: str, keyword: str, drive_id: str = DRIVE_UCETNICTVI) -> Optional[dict]:
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

def get_bank_statements(company: str, year: str, month: str, cache_dir: Path = Path('/tmp/finance_cache')) -> list[Path]:
    """
    Stáhne bankovní výpisy pro danou firmu, rok a měsíc.
    Vrátí seznam stažených PDF souborů.
    company: 'baker', 'pinehill', etc.
    year: '2025'
    month: '03' (dvouciferný)
    """
    service = _get_service()
    drive_id, company_id = _resolve_company(company, year)

    # Navigate: firma > rok > YYYYMM > Výpisy... (new drive)
    # or: firma > Finance > Účetnictví > rok > ... (Business Docs)
    year_folder = find_folder(service, company_id, year, drive_id)
    if not year_folder:
        raise FileNotFoundError(f"Složka roku {year} nenalezena pro {company}")

    # New drive (Účetnictví Obluk): rok > YYYYMM > Výpisy
    # Historical (Business Docs): rok > contains files directly or subfolders
    month_folder = find_folder(service, year_folder, f"{year}{month}", drive_id)
    if month_folder:
        vyp_folder = find_folder_contains(service, month_folder, 'výpis', drive_id)
        if not vyp_folder:
            raise FileNotFoundError(f"Složka výpisů nenalezena v {year}{month}")
        search_id = vyp_folder['id']
    else:
        # Historical drive: files may be directly in year folder
        search_id = year_folder

    files = ls(service, search_id, drive_id)
    pdf_files = []

    for f in files:
        if 'folder' in f['mimeType']:
            # Podadresář (KB, FIO, apod.) — stáhnout vše z něj
            for sf in ls(service, f['id']):
                if sf.get('fileExtension', '').lower() == 'pdf':
                    dest = cache_dir / company / year / month / f['name'] / sf['name']
                    if not dest.exists():
                        download_file(service, sf['id'], dest)
                    pdf_files.append(dest)
        elif f.get('fileExtension', '').lower() == 'pdf':
            dest = cache_dir / company / year / month / f['name']
            if not dest.exists():
                download_file(service, f['id'], dest)
            pdf_files.append(dest)

    return pdf_files

def get_invoices(company: str, year: str, month: str, direction: str = 'both',
                 cache_dir: Path = Path('/tmp/finance_cache')) -> list[Path]:
    """
    Stáhne faktury pro danou firmu, rok a měsíc.
    direction: 'received' | 'issued' | 'both'
    """
    service = _get_service()
    company_id = COMPANY_FOLDERS.get(company.lower())
    if not company_id:
        raise ValueError(f"Neznámá firma: {company}")

    year_folder = find_folder(service, company_id, year)
    if not year_folder:
        raise FileNotFoundError(f"Složka roku {year} nenalezena")

    month_folder = find_folder(service, year_folder, f"{year}{month}")
    if not month_folder:
        raise FileNotFoundError(f"Složka {year}{month} nenalezena")

    keywords = []
    if direction in ('received', 'both'):
        keywords.append('přijaté')
    if direction in ('issued', 'both'):
        keywords.append('vydané')

    pdf_files = []
    for kw in keywords:
        folder = find_folder_contains(service, month_folder, kw)
        if not folder:
            continue
        for f in ls(service, folder['id']):
            if f.get('fileExtension', '').lower() == 'pdf':
                dest = cache_dir / company / year / month / 'faktury' / kw / f['name']
                if not dest.exists():
                    download_file(service, f['id'], dest)
                pdf_files.append(dest)

    return pdf_files

if __name__ == '__main__':
    # Test
    files = get_bank_statements('baker', '2025', '03')
    print(f"Staženo {len(files)} souborů:")
    for f in files:
        print(f"  {f}")
