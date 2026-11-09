import json, os
from pathlib import Path

def test_manifest_real():
 p=Path('data/web/lowair_atmos/manifest.json')
 if not p.exists(): return
 m=json.loads(p.read_text()); assert len(m['variables'])==23
 assert m['variables']['w']['shape']==[40,300,300]
 for n,v in m['variables'].items(): assert (p.parent/v['file']).stat().st_size==v['bytes_compressed']
