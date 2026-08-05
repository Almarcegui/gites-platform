#!/usr/bin/env python3
"""Pont de dev local : pousse dispo + prix + min-nuits de la plateforme (API
locale :8788) vers Beds24 (API v2). Nécessaire en local car les fetch sortants
du Worker échouent sous VPN Emeria (cf. README § Beds24) — en production le
cron du Worker fait la même chose sans ce script.

Usage : python3 scripts/beds24_push_calendar.py [mois=12]
"""
import json
import pathlib
import sys
import urllib.request
from datetime import date

BASE = "http://localhost:8788"
API = "https://api.beds24.com/v2"
# Mapping migration 0010 — unité locale → room Beds24
ROOMS = {1: 711713, 2: 711714}  # Scieur, Scierie (le Domaine reste direct-only)

def local(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return json.load(r)

def beds24(path, token, body=None, method=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"token": token, **({"content-type": "application/json"} if body is not None else {})},
        method=method or ("POST" if body is not None else "GET"),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def month_add(ym, delta):
    y, m = map(int, ym.split("-"))
    m += delta
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return f"{y:04d}-{m:02d}"

def main(months=12):
    refresh = next(l.split("=", 1)[1] for l in pathlib.Path(".dev.vars").read_text().splitlines()
                   if l.startswith("BEDS24_REFRESH_TOKEN="))
    req = urllib.request.Request(f"{API}/authentication/token", headers={"refreshToken": refresh})
    with urllib.request.urlopen(req, timeout=30) as r:
        token = json.load(r)["token"]

    today = local("/api/public/today")["today"]
    days_by_unit = {uid: [] for uid in ROOMS}
    ym = today[:7]
    for i in range(months):
        cal = local(f"/api/public/calendar?property=pre-more&month={month_add(ym, i)}")
        for unit in cal["units"]:
            if unit["unitId"] not in ROOMS:
                continue
            for d in unit["days"]:
                if d["date"] < today:
                    continue
                days_by_unit[unit["unitId"]].append({
                    "date": d["date"],
                    "numAvail": 1 if d["available"] else 0,
                    "price1": round(d["priceCents"] / 100, 2) if d.get("priceCents") is not None else None,
                    "minStay": d.get("minNights"),
                })

    def compact(days):
        spans = []
        prev_date = None
        for d in days:
            same = (spans and spans[-1]["numAvail"] == d["numAvail"]
                    and spans[-1].get("price1") == d["price1"]
                    and spans[-1].get("minStay") == d["minStay"]
                    and prev_date is not None and _next(prev_date) == d["date"])
            if same:
                spans[-1]["to"] = d["date"]
            else:
                span = {"from": d["date"], "to": d["date"], "numAvail": d["numAvail"]}
                if d["price1"] is not None:
                    span["price1"] = d["price1"]
                if d["minStay"] is not None:
                    span["minStay"] = d["minStay"]
                spans.append(span)
            prev_date = d["date"]
        return spans

    def _next(iso):
        y, m, dd = map(int, iso.split("-"))
        return (date(y, m, dd).toordinal() + 1) and date.fromordinal(date(y, m, dd).toordinal() + 1).isoformat()

    body = []
    for uid, room_id in ROOMS.items():
        spans = compact(days_by_unit[uid])
        body.append({"roomId": room_id, "calendar": spans})
        print(f"unité {uid} → room {room_id} : {len(days_by_unit[uid])} jours → {len(spans)} plages")

    out = beds24("/inventory/rooms/calendar", token, body=body)
    ok = all(item.get("success") for item in out) if isinstance(out, list) else out
    print("push Beds24 :", "SUCCÈS" if ok else json.dumps(out)[:400])

    # contrôle : relire 7 jours du calendrier Beds24
    check = beds24(f"/inventory/rooms/calendar?startDate={today}&endDate={_next(_next(today))}&roomId={ROOMS[1]}&roomId={ROOMS[2]}", token)
    print("contrôle lecture :", json.dumps(check.get("data", check), ensure_ascii=False)[:500])

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 12)
