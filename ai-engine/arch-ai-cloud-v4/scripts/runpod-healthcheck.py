import json
import urllib.request


try:
    with urllib.request.urlopen("http://127.0.0.1:8080/healthz", timeout=3) as response:
        body = json.loads(response.read(4096))
        if response.status != 200 or body != {"status": "READY"}:
            raise SystemExit(1)
except Exception:
    raise SystemExit(1)
