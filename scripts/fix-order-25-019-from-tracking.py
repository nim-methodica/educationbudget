import json
import shutil
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "app-data.json"
BACKUP_DIR = ROOT / ".tmp" / "backups"


ORDER_NUMBER = "25-019"
ORDER_LINES = [
    {
        "code": "34.2",
        "name": "אינפוגרפיקה מתקדמת",
        "quantity": 2,
        "unitCost": 4400,
        "utilizedQuantity": 2,
    },
    {
        "code": "41",
        "name": "שעת מומחה תוכן, ייעוץ מדעי וייעוץ טכנו-פדגוגי מדעי",
        "quantity": 100,
        "unitCost": 330,
        "utilizedQuantity": 100,
    },
    {
        "code": "42",
        "name": "שעת פיתוח הדרכה מתוקשבת",
        "quantity": 70,
        "unitCost": 280,
        "utilizedQuantity": 70,
    },
]


def main():
    state = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DATA_FILE, BACKUP_DIR / f"app-data-before-fix-{ORDER_NUMBER}-{stamp}.json")

    updated = False
    for framework in state.get("frameworks", []):
        for regulation in framework.get("regulations", []):
            for order in regulation.get("projectOrders", []):
                if order.get("orderNumber") != ORDER_NUMBER:
                    continue
                order["lines"] = [line.copy() for line in ORDER_LINES]
                order["totalWithoutVat"] = sum(line["quantity"] * line["unitCost"] for line in ORDER_LINES)
                order["status"] = "closed"
                updated = True

    if not updated:
        raise RuntimeError(f"Order {ORDER_NUMBER} was not found")

    DATA_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "orderNumber": ORDER_NUMBER,
        "lines": len(ORDER_LINES),
        "totalWithoutVat": sum(line["quantity"] * line["unitCost"] for line in ORDER_LINES),
        "totalWithVat": round(sum(line["quantity"] * line["unitCost"] for line in ORDER_LINES) * 1.18, 2),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
