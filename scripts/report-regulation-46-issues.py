import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIT_FILE = ROOT / "outputs" / "framework-items-audit.json"
OUT_FILE = ROOT / "outputs" / "פערי-תקנה-46.md"


def fmt(value):
    number = float(value or 0)
    if number == int(number):
        return f"{int(number):,}"
    return f"{number:,.2f}"


def main():
    data = json.loads(AUDIT_FILE.read_text(encoding="utf-8"))
    rows = [row for row in data["issues"] if row["regulation"] == "46"]
    lines = [
        "# פערי תקנה 46",
        "",
        "| סעיף | שם פריט | כמות במסגרת | נוצל בהזמנות | שולם | ביצוע מצטבר | סוג פער | הזמנות |",
        "|---|---|---:|---:|---:|---:|---|---|",
    ]
    for row in rows:
        orders = ", ".join(
            f"{order.get('orderNumber')} ({fmt(order.get('quantity'))})"
            for order in row.get("orders", [])
        )
        lines.append(
            "| "
            + " | ".join([
                str(row["code"]),
                str(row.get("name") or ""),
                fmt(row["systemFrameworkQty"]),
                fmt(row["reservedQty"]),
                fmt(row["paidQty"]),
                fmt(row["executionQty"]),
                ", ".join(row["issues"]),
                orders or "-",
            ])
            + " |"
        )
    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(len(rows))
    for row in rows:
        print(f"{row['code']}|{fmt(row['systemFrameworkQty'])}|{fmt(row['reservedQty'])}|{fmt(row['paidQty'])}|{fmt(row['executionQty'])}".encode("unicode_escape").decode("ascii"))


if __name__ == "__main__":
    main()
