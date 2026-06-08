import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIT_FILE = ROOT / "outputs" / "framework-items-audit.json"
OUT_FILE = ROOT / "outputs" / "פערי-ניצול-מעל-מסגרת-תקנה-92.md"


def fmt(value):
    number = float(value or 0)
    if number == int(number):
        return f"{int(number):,}"
    return f"{number:,.2f}"


def is_numeric_item_code(value):
    text = str(value or "").strip()
    return bool(text) and all(part.isdigit() for part in text.split("."))


def main():
    data = json.loads(AUDIT_FILE.read_text(encoding="utf-8"))
    rows = [
        row for row in data["issues"]
        if row["regulation"] == "92" and "ניצול בהזמנות מעל מסגרת" in row["issues"]
    ]
    lines = [
        "# פערי ניצול מעל מסגרת - תקנה 92",
        "",
        "| סעיף | שם פריט | כמות במסגרת | נוצל בהזמנות | חריגה | שולם | ביצוע מצטבר | הזמנות שיוצרות ניצול |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        orders = ", ".join(
            f"{order.get('orderNumber')} ({fmt(order.get('quantity'))})"
            for order in row.get("orders", [])
        )
        over = float(row["reservedQty"] or 0) - float(row["systemFrameworkQty"] or 0)
        lines.append(
            "| "
            + " | ".join([
                str(row["code"]),
                str(row.get("name") or ""),
                fmt(row["systemFrameworkQty"]),
                fmt(row["reservedQty"]),
                fmt(over),
                fmt(row["paidQty"]),
                fmt(row["executionQty"]),
                orders,
            ])
            + " |"
        )
    data_quality_rows = [row for row in rows if not is_numeric_item_code(row["code"])]
    if data_quality_rows:
        lines.extend([
            "",
            "## שורות חשודות לניקוי",
            "",
            "| סעיף שנקלט | נוצל בהזמנות | הזמנות |",
            "|---|---:|---|",
        ])
        for row in data_quality_rows:
            orders = ", ".join(
                f"{order.get('orderNumber')} ({fmt(order.get('quantity'))})"
                for order in row.get("orders", [])
            )
            lines.append(f"| {row['code']} | {fmt(row['reservedQty'])} | {orders} |")
    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(len(rows))
    for row in rows:
        over = float(row["reservedQty"] or 0) - float(row["systemFrameworkQty"] or 0)
        print(f"{row['code']}|{fmt(row['systemFrameworkQty'])}|{fmt(row['reservedQty'])}|{fmt(over)}".encode("unicode_escape").decode("ascii"))


if __name__ == "__main__":
    main()
