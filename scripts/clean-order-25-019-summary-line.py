import json
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATE_FILE = ROOT / ".tmp" / "state-current.json"
API_BASE = "http://localhost:4235"


def api(path, method="GET", body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(f"{API_BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def main():
    state = api("/api/state")
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    for framework in state.get("frameworks", []):
        for regulation in framework.get("regulations", []):
            for order in regulation.get("projectOrders", []):
                if order.get("orderNumber") != "25-019":
                    continue
                original_lines = order.get("lines", [])
                cleaned_lines = [
                    line for line in original_lines
                    if str(line.get("code", "")).strip() != "סיכום"
                ]
                if len(cleaned_lines) == len(original_lines):
                    print("no-change")
                    return
                body = {
                    "orderNumber": order.get("orderNumber"),
                    "projectName": order.get("projectName"),
                    "customerUnit": order.get("customerUnit"),
                    "issuedAt": order.get("issuedAt"),
                    "expectedEndAt": order.get("expectedEndAt"),
                    "sourceFile": order.get("sourceFile"),
                    "totalWithoutVat": order.get("totalWithoutVat"),
                    "lines": cleaned_lines,
                }
                api(f"/api/orders/{order['id']}", method="PATCH", body=body)
                print(f"cleaned|{len(original_lines)}|{len(cleaned_lines)}")
                return
    raise SystemExit("order 25-019 not found")


if __name__ == "__main__":
    main()
