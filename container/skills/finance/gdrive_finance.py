"""
GDrive Finance Downloader
Stahuje finanční dokumenty z Google Drive (Účetnictví Obluk).
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

# Shared drive IDs
DRIVE_ID = '0ANtUxhg1AfrCUk9PVA'  # Účetnictví Obluk
COMPANY_FOLDERS = {
    'baker':     '1fIf_kPTPggxw_KJwiMEfClabO_b1Gw35',
    'pinehill':  '1LqkTy7RV-umhlU_lJRMwmKtFy7AjfN1w',
    'pinehouse': '1gVluMW-KRGkdwlkxBAp3-QDsbgXVlhzG',
    'pineinvest':'1Jir9F5CO0v6MxZARy8Fmkxapd3MbV2-8',
    'pineair':   '1TdatGQksDHSDW7qTU2v6DFNo8OXe8ftk',
}

def _get_service():
    creds = _gdrive_mod._get_credentials()
    return build('drive', 'v3', credentials=creds)

def ls(service, folder_id: str) -> list:
    """List files in folder."""
    r = service.files().list(
        q=f"'{folder_id}' in parents",
        driveId=DRIVE_ID, corpora='drive',
        includeItemsFromAllDrives=True, supportsAllDrives=True,
        fields='files(id,name,mimeType,size,fileExtension)',
        orderBy='name'
    ).execute()
    return r.get('files', [])

def find_folder(service, parent_id: str, name: str) -> Optional[str]:
    """Find subfolder by name, return id or None."""
    for f in ls(service, parent_id):
        if f['name'] == name and 'folder' in f['mimeType']:
            return f['id']
    return None

def find_folder_contains(service, parent_id: str, keyword: str) -> Optional[dict]:
    """Find subfolder containing keyword in name."""
    for f in ls(service, parent_id):
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
    company_id = COMPANY_FOLDERS.get(company.lower())
    if not company_id:
        raise ValueError(f"Neznámá firma: {company}. Dostupné: {list(COMPANY_FOLDERS.keys())}")

    # Navigate: firma > rok > YYYYMM > Výpisy...
    year_folder = find_folder(service, company_id, year)
    if not year_folder:
        raise FileNotFoundError(f"Složka roku {year} nenalezena pro {company}")

    month_folder = find_folder(service, year_folder, f"{year}{month}")
    if not month_folder:
        raise FileNotFoundError(f"Složka {year}{month} nenalezena")

    vyp_folder = find_folder_contains(service, month_folder, 'výpis')
    if not vyp_folder:
        raise FileNotFoundError(f"Složka výpisů nenalezena v {year}{month}")

    # Výpisy mohou být v podsložce (např. KB/)
    files = ls(service, vyp_folder['id'])
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
