#!/usr/bin/env python3
"""Download only explicitly requested files into persistent model folders.

Examples:
  python scripts/download-models.py config/models-example.json --list
  python scripts/download-models.py config/models-example.json --only sdxl-base
  python scripts/download-models.py config/models-example.json --only sdxl-depth --only 4x-ultrasharp
"""
import argparse
import json
from pathlib import Path
from huggingface_hub import hf_hub_download

parser = argparse.ArgumentParser()
parser.add_argument('manifest', type=Path)
parser.add_argument('--only', action='append', help='Model id; repeat flag for multiple models')
parser.add_argument('--list', action='store_true')
parser.add_argument('--workspace', type=Path, default=Path('/workspace'))
args = parser.parse_args()
entries = json.loads(args.manifest.read_text(encoding='utf-8'))['models']
if args.list:
    for entry in entries:
        print(entry['id'], ':', entry['repo'], entry['file'])
    raise SystemExit(0)
selected = [m for m in entries if args.only and m['id'] in args.only]
if not args.only:
    parser.error('Specify --only id (never downloads all models automatically)')
missing = set(args.only) - {m['id'] for m in selected}
if missing:
    parser.error('Unknown id(s): ' + ', '.join(sorted(missing)))
for model in selected:
    folder = args.workspace / 'models' / model['folder']
    folder.mkdir(parents=True, exist_ok=True)
    print('Downloading:', model['id'], '=>', folder, flush=True)
    path = hf_hub_download(repo_id=model['repo'], filename=model['file'], local_dir=folder)
    source = Path(path)
    target_name = model.get('target_name', source.name)
    dest = folder / target_name
    if source.resolve() != dest.resolve():
        if dest.exists() and not dest.is_symlink():
            raise FileExistsError(f'Destination already exists: {dest}')
        if dest.exists() and dest.is_symlink():
            dest.unlink()
        rel = source.relative_to(folder) if source.is_relative_to(folder) else source
        dest.symlink_to(rel)
    print('Ready:', dest, flush=True)
