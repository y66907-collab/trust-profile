"""CLI over app.public_registries.

    python scripts/registry_lookup.py "משה כהן" --city "חיפה"
    python scripts/registry_lookup.py "משה כהן" --en "Moshe Cohen"
"""

import argparse
import sys

from app.public_registries import lookup


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("name_he")
    p.add_argument("--en", default="")
    p.add_argument("--city", default="")
    args = p.parse_args()

    res = lookup(args.name_he.strip(), args.en.strip(), args.city.strip())
    for h in res["people"] + res["companies"]:
        mark = {True: "📍", False: "  ", None: "  "}[h["city_match"]]
        print(f"{'✔' if h['exact'] else '·'} {mark} {h['registry']:<16} {h['name']:<28} {h['detail']}  {h['city']}")
    for e in res["errors"]:
        print(f"! {e}", file=sys.stderr)
    if not res["people"] and not res["companies"]:
        print("לא נמצא")


if __name__ == "__main__":
    main()
