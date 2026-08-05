#!/usr/bin/env python3
"""Génère la page hub /prive/gites/ — instantané de la plateforme de gestion
des gîtes, à partir de la base D1 LOCALE (lecture seule du SQLite miniflare).

Appelé par build_dashboard.py (hub Teoma, 3×/jour ouvré via launchd) ; peut
aussi être lancé seul. Python stdlib uniquement, aucun appel réseau, aucune
écriture hors de _scratch/deploy/ du projet hub. Ne casse jamais le build du
hub : en cas de pépin, il écrit une page « pas de données » et sort en 0.
"""
from __future__ import annotations

import glob
import html
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Base des liens de la page hub. La plateforme est en ligne depuis le 2026-08-03 ;
# quand le domaine définitif sera tranché, une seule ligne change ici — ou on
# passe GITES_SITE_BASE dans l'environnement sans toucher au script.
SITE_BASE = os.environ.get(
    "GITES_SITE_BASE", "https://gites-platform.j-decartier.workers.dev"
).rstrip("/")

VAULT = Path.home() / "Documents" / "Claude"
PLATFORM = VAULT / "🔧 Dev" / "Gites Platform"
DEPLOY = VAULT / "🔧 Dev" / "Dashboards Hub Cloudflare" / "_scratch" / "deploy"
OUT = DEPLOY / "prive" / "gites" / "index.html"

TODAY = date.today()
NOW_SQL = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

esc = html.escape


def eur(cents) -> str:
    v = (cents or 0) / 100
    s = f"{v:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} €"


def dfr(iso: str) -> str:
    return f"{iso[8:10]}/{iso[5:7]}" if iso else "—"


def find_db() -> Path | None:
    pattern = str(PLATFORM / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject" / "*.sqlite")
    files = sorted(glob.glob(pattern), key=lambda p: Path(p).stat().st_mtime, reverse=True)
    return Path(files[0]) if files else None


def q(con, sql, args=()):
    cur = con.execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def collect() -> dict | None:
    db_path = find_db()
    if not db_path:
        return None
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        data = {}
        data["properties"] = q(con, "SELECT id, name FROM properties WHERE active = 1 ORDER BY id")
        data["units"] = q(con, """SELECT u.id, u.property_id, u.name, u.is_composite, u.capacity_base, u.capacity_max
                                   FROM units u WHERE u.active = 1 ORDER BY u.property_id, u.sort_order""")
        data["links"] = q(con, "SELECT unit_id, blocks_unit_id FROM unit_links")
        data["bookings"] = q(con, """
            SELECT b.id, b.reference, b.unit_id, b.checkin, b.checkout, b.status, b.source,
                   b.total_cents, b.paid_cents, b.balance_due_date, b.channel_label,
                   TRIM(COALESCE(g.first_name,'') || ' ' || COALESCE(g.last_name,'')) AS guest
              FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
             WHERE (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > ?))
             ORDER BY b.checkin""", (NOW_SQL,))
        try:
            data["emails_new"] = q(con, "SELECT COUNT(*) AS n FROM messages WHERE status = 'nouveau' AND direction = 'in'")[0]["n"]
        except sqlite3.OperationalError:
            data["emails_new"] = None
        data["feeds"] = q(con, "SELECT name, last_status, last_sync_at FROM ical_feeds WHERE active = 1")
        return data
    finally:
        con.close()


def build_page(data: dict | None) -> str:
    stamp = datetime.now().strftime("%d/%m/%Y à %H:%M")
    body_parts: list[str] = []

    if data is None:
        body_parts.append('<div class="note">Base locale introuvable — lancer la plateforme au moins une fois '
                          '(<code>npm run db:migrate:local</code> dans 🔧 Dev/Gites Platform).</div>')
    else:
        today_iso = TODAY.isoformat()
        horizon14 = (TODAY + timedelta(days=14)).isoformat()
        bookings = data["bookings"]
        units_by_id = {u["id"]: u for u in data["units"]}
        prop_by_id = {p["id"]: p for p in data["properties"]}

        upcoming = [b for b in bookings if b["checkout"] > today_iso]
        current = [b for b in upcoming if b["checkin"] <= today_iso]
        future = [b for b in upcoming if b["checkin"] > today_iso]
        balances = [b for b in upcoming if b["status"] == "confirmed" and (b["total_cents"] or 0) > (b["paid_cents"] or 0)]
        balance_total = sum((b["total_cents"] or 0) - (b["paid_cents"] or 0) for b in balances)
        options = [b for b in upcoming if b["status"] == "pending"]

        # KPIs
        next_arrival = future[0] if future else None
        kpis = [
            ("Séjours en cours", str(len(current)) or "0", ""),
            ("Résas à venir", str(len(future)), f"dont {len(options)} option(s)" if options else ""),
            ("Prochaine arrivée", dfr(next_arrival["checkin"]) if next_arrival else "—",
             esc(units_by_id.get(next_arrival["unit_id"], {}).get("name", "")) if next_arrival else "aucune"),
            ("Soldes à encaisser", eur(balance_total), f"{len(balances)} dossier(s)" if balances else "à jour"),
        ]
        body_parts.append('<div class="kpis">' + "".join(
            f'<div class="kpi"><div class="l">{esc(l)}</div><div class="v">{esc(v)}</div><div class="s">{s}</div></div>'
            for l, v, s in kpis) + "</div>")

        # Par bien : prochaine occupation (résa propre ou blocage par liaison)
        rows = []
        for u in data["units"]:
            blockers = {u["id"]} | {l["unit_id"] for l in data["links"] if l["blocks_unit_id"] == u["id"]}
            occ = [b for b in upcoming if b["unit_id"] in blockers]
            occ.sort(key=lambda b: b["checkin"])
            nxt = occ[0] if occ else None
            if nxt is None:
                state = '<span class="tag ok">libre</span>'
            else:
                own = nxt["unit_id"] == u["id"]
                en_cours = nxt["checkin"] <= today_iso
                label = "en cours" if en_cours else dfr(nxt["checkin"]) + " → " + dfr(nxt["checkout"])
                who = esc(nxt["guest"] or nxt["channel_label"] or nxt["reference"])
                state = (f'<span class="tag {"warn" if not own else ("chan" if nxt["source"]=="ical" else "res")}">'
                         f'{"🔗 bloqué (liaison)" if not own else ("séjour " + label) if en_cours else label}</span> '
                         f'<span class="mut">{who if own else nxt["reference"]}</span>')
            prop = prop_by_id.get(u["property_id"], {})
            rows.append(f'<tr><td><b>{esc(u["name"])}</b>{" 🔗" if u["is_composite"] else ""}'
                        f'<span class="mut"> · {esc(prop.get("name",""))}</span></td><td>{state}</td></tr>')
        body_parts.append(f'<div class="card"><h3>Mes biens</h3><table>{"".join(rows)}</table></div>')

        # Arrivées / départs 14 jours
        moves = []
        for b in upcoming:
            u = units_by_id.get(b["unit_id"], {})
            if today_iso <= b["checkin"] < horizon14:
                moves.append((b["checkin"], "→ arrivée", b, u))
            if today_iso <= b["checkout"] < horizon14:
                moves.append((b["checkout"], "← départ", b, u))
        moves.sort(key=lambda m: m[0])
        if moves:
            mrows = "".join(
                f'<tr><td>{dfr(d)}</td><td>{k}</td><td>{esc(u.get("name",""))}</td>'
                f'<td>{esc(b["guest"] or b["channel_label"] or "—")}</td>'
                f'<td class="mut">{esc(b["reference"])}</td></tr>'
                for d, k, b, u in moves[:12])
            body_parts.append(f'<div class="card"><h3>Arrivées &amp; départs — 14 jours</h3>'
                              f'<table><tr><th>Date</th><th></th><th>Bien</th><th>Client</th><th>Réf</th></tr>{mrows}</table></div>')

        # Alertes
        alerts = []
        for b in balances:
            if b["balance_due_date"] and b["balance_due_date"] <= today_iso:
                alerts.append(f'⚠️ Solde en retard — {esc(b["reference"])} ({eur((b["total_cents"] or 0) - (b["paid_cents"] or 0))})')
        for f in data["feeds"]:
            if f["last_status"] and f["last_status"] != "ok":
                alerts.append(f'📡 Flux iCal « {esc(f["name"])} » : {esc(f["last_status"])}')
        if data["emails_new"]:
            alerts.append(f'✉️ {data["emails_new"]} message(s) client à traiter')
        if alerts:
            body_parts.append('<div class="card"><h3>Alertes</h3><ul>' +
                              "".join(f"<li>{a}</li>" for a in alerts) + "</ul></div>")

    body_parts.append(
        '<p class="foot">Instantané généré le ' + esc(stamp) + " — rafraîchi avec le hub (8h05 / 13h05 / 18h10 L-V).<br>"
        'Plateforme en ligne : <code>' + esc(SITE_BASE) + "</code>. "
        'Code sur GitHub (<code>jdecartier-glitch/gites-platform</code>, dépôt privé) ; '
        "en local : <code>npm run dev -- --port 8788</code>.</p>")

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Plateforme Gîtes — état</title>
<style>
:root{{--bg:#F7F6F3;--ink:#1F2937;--muted:#6B7280;--line:#E5E1D8;--accent:#2F5D3F;--accent2:#A16207}}
*{{box-sizing:border-box;margin:0}}
body{{font:14px/1.5 -apple-system,'Inter','Segoe UI',sans-serif;background:var(--bg);color:var(--ink);padding:26px 16px}}
.wrap{{max-width:860px;margin:0 auto}}
h1{{font-size:20px;margin-bottom:2px}} .sub{{color:var(--muted);font-size:12.5px;margin-bottom:18px}}
.sub a{{color:var(--accent)}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}}
.kpi{{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}}
.kpi .l{{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}}
.kpi .v{{font-size:22px;font-weight:650;margin:2px 0}} .kpi .s{{font-size:11.5px;color:var(--muted)}}
.card{{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}}
h3{{font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-bottom:10px}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
th{{text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--muted);padding:4px 8px;border-bottom:1px solid var(--line)}}
td{{padding:7px 8px;border-bottom:1px solid #F0EDE5}}
.tag{{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600}}
.tag.ok{{background:#E6EFE8;color:#2F5D3F}} .tag.res{{background:#2F5D3F;color:#fff}}
.tag.warn{{background:#EAE6DC;color:#6B7280}} .tag.chan{{background:#EEE7FA;color:#6D28D9}}
.mut{{color:var(--muted);font-size:12px}}
.note{{background:#FBF7EC;border:1px solid #EADFC0;border-radius:6px;padding:10px 14px;font-size:13px;color:#7a6a33}}
.btns{{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}}
.btn{{display:inline-block;background:var(--accent);color:#fff;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:600;text-decoration:none}}
.btn.o{{background:#fff;color:var(--accent);border:1.5px solid var(--accent)}}
ul{{padding-left:18px}} li{{margin:4px 0}}
.foot{{color:var(--muted);font-size:11.5px;margin-top:18px}}
code{{background:#EEECE6;border-radius:3px;padding:0 4px;font-size:12px}}
</style></head><body><div class="wrap">
<h1>⌂ Plateforme Gîtes</h1>
<p class="sub">Pré Moré &amp; Moulin de Braives — réservations en direct · <a href="/prive/">← privé</a></p>
<p class="btns">
  <a class="btn" href="{SITE_BASE}/admin/">⚙️ Ouvrir le back-office</a>
  <a class="btn o" href="{SITE_BASE}/">🏡 Site Pré Moré (refonte)</a>
  <a class="btn o" href="{SITE_BASE}/book/">🌐 Réservation (client)</a>
  <a class="btn o" href="{SITE_BASE}/book/?property=moulin-braives">Moulin</a>
</p>
<p class="mut" style="font-size:11.5px;margin:-6px 0 14px">Site en ligne depuis le 3 août — ces liens marchent depuis n'importe où, téléphone compris. ⚠️ Les chiffres ci-dessous viennent encore de la base <strong>locale</strong> du Mac, pas de celle en ligne : à lire comme un instantané de développement, pas comme l'état réel des réservations.</p>
{"".join(body_parts)}
</div></body></html>"""


def main() -> int:
    try:
        data = collect()
    except Exception as e:  # jamais casser le build du hub
        print(f"build_hub_page: erreur de lecture ({e}) — page dégradée", file=sys.stderr)
        data = None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    page = build_page(data)
    OUT.write_text(page, encoding="utf-8")
    print(f"  ✓ prive/gites/index.html ({len(page):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
