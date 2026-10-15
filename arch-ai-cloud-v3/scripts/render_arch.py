#!/usr/bin/env python3
"""Upload source/depth/normal images and queue an architecture workflow in ComfyUI.

Examples:
  python scripts/render_arch.py source.png \
    --workflow workflows/architecture_canny_4k_api.json

  python scripts/render_arch.py source.png --depth-map depth.png \
    --workflow workflows/architecture_depth_4k_api.json

  python scripts/render_arch.py source.png --depth-map depth.png --normal-map normal.png \
    --workflow workflows/architecture_canny_depth_normal_4k_api.json
"""
import argparse
import json
import random
from pathlib import Path
import requests


def upload_image(server: str, path: Path) -> str:
    with path.open('rb') as f:
        r = requests.post(
            server + '/upload/image',
            files={'image': (path.name, f, 'application/octet-stream')},
            data={'overwrite': 'false'},
            timeout=300,
        )
    r.raise_for_status()
    data = r.json()
    if data.get('subfolder'):
        return f"{data['subfolder']}/{data['name']}"
    return data['name']


def set_if_present(flow, node_id, input_name, value):
    if node_id in flow and 'inputs' in flow[node_id] and input_name in flow[node_id]['inputs']:
        flow[node_id]['inputs'][input_name] = value


p = argparse.ArgumentParser()
p.add_argument('image', type=Path)
p.add_argument('--depth-map', type=Path)
p.add_argument('--normal-map', type=Path)
p.add_argument('--server', default='http://127.0.0.1:8188')
p.add_argument('--workflow', type=Path, default=Path(__file__).resolve().parents[1] / 'workflows/architecture_canny_4k_api.json')
p.add_argument('--prompt', default=None)
p.add_argument('--negative', default=None)
p.add_argument('--denoise', type=float, default=0.28)
p.add_argument('--canny-strength', type=float, default=0.7)
p.add_argument('--depth-strength', type=float, default=0.75)
p.add_argument('--normal-strength', type=float, default=0.35)
p.add_argument('--seed', type=int, default=None)
a = p.parse_args()

if not a.image.is_file():
    p.error('Input image not found')
if a.depth_map and not a.depth_map.is_file():
    p.error('Depth map not found')
if a.normal_map and not a.normal_map.is_file():
    p.error('Normal map not found')

server = a.server.rstrip('/')
flow = json.loads(a.workflow.read_text(encoding='utf-8'))

source_name = upload_image(server, a.image)
set_if_present(flow, '1', 'image', source_name)

if a.depth_map:
    depth_name = upload_image(server, a.depth_map)
    set_if_present(flow, '16', 'image', depth_name)
if a.normal_map:
    normal_name = upload_image(server, a.normal_map)
    set_if_present(flow, '20', 'image', normal_name)

if a.prompt:
    set_if_present(flow, '4', 'text', a.prompt)
if a.negative:
    set_if_present(flow, '5', 'text', a.negative)

set_if_present(flow, '10', 'denoise', a.denoise)
set_if_present(flow, '9', 'strength', a.canny_strength)
set_if_present(flow, '19', 'strength', a.depth_strength)
set_if_present(flow, '23', 'strength', a.normal_strength)
set_if_present(flow, '10', 'seed', a.seed if a.seed is not None else random.randrange(0, 2**53))

r = requests.post(server + '/prompt', json={'prompt': flow}, timeout=300)
if not r.ok:
    print('ComfyUI rejected the workflow:', r.text)
r.raise_for_status()
print(json.dumps(r.json(), indent=2, ensure_ascii=False))
print('Queue submitted. Inspect /history/<prompt_id> or the output folder.')
