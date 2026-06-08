import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATE_FILE = ROOT / ".tmp" / "state-current.json"
JSON_FILE = ROOT / "data" / "app-data.json"


def clean(data):
    changed = False
    for framework in data.get("frameworks", []):
        for regulation in framework.get("regulations", []):
            for order in regulation.get("projectOrders", []):
                if order.get("orderNumber") != "25-019":
                    continue
                before = len(order.get("lines", []))
                order["lines"] = [
                    line for line in order.get("lines", [])
                    if str(line.get("code", "")).strip() != "סיכום"
                ]
                changed = changed or len(order["lines"]) != before
    return changed


def main():
    source = STATE_FILE if STATE_FILE.exists() else JSON_FILE
    data = json.loads(source.read_text(encoding="utf-8-sig"))
    changed = clean(data)
    JSON_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("cleaned" if changed else "no-change")


if __name__ == "__main__":
    main()
