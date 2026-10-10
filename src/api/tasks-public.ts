// Page publique de la personne du ménage : GET /t/<jeton>.
//
// Sans connexion : le lien EST l'accès (jeton aléatoire de 24 octets, seul son
// SHA-256 en base, coupable depuis l'écran Ménage). La page ne montre aucune
// donnée de voyageur : bien, jour, heure de départ, arrivée suivante, nombre
// de personnes, note de l'équipe. Elle marche sans JavaScript : chaque case
// est un petit formulaire POST qui renvoie sur la page (303).
//
// Cibles de 44 px au moins, texte de 18 px, contraste fort : elle se lit au
// soleil, sur un vieux téléphone, avec des gants.
import { apiError, type Router } from "./router";
import { addDays, todayInZone } from "../core/dates";
import { listTasks, resolveShareLink, touchShareLink, updateTask, getTask, type TaskRow } from "../db/tasks";
import { audit, listProperties } from "../db/repo";

/** Fenêtre montrée : hier (ce qui reste à cocher) et les deux semaines à venir. */
const PAST_DAYS = 1;
const AHEAD_DAYS = 14;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Le jeton est dans l'adresse : il ne doit fuiter ni vers un autre site, ni
  // dans un moteur de recherche.
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return `${JOURS[dt.getUTCDay()]} ${d} ${MOIS[(m ?? 1) - 1]}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hour(t: string | null): string {
  if (!t) return "";
  const [h, mi] = t.split(":");
  return mi && mi !== "00" ? `${Number(h)} h ${mi}` : `${Number(h)} h`;
}

function card(token: string, k: TaskRow, today: string): string {
  const done = k.status === "fait";
  const title = k.isComposite ? `Les deux maisons, après ${esc(k.unitName)}` : esc(k.unitName);
  const sameDay = k.nextCheckin === k.dueDate;
  const next = k.nextCheckin
    ? sameDay
      ? `<p class="tight">À finir avant ${esc(hour(k.nextCheckinTime))} : nouveaux voyageurs le jour même${k.nextPersons ? `, ${k.nextPersons} personnes` : ""}${k.nextUnitName && k.nextUnitName !== k.unitName ? ` (${esc(k.nextUnitName)})` : ""}.</p>`
      : `<p>Prochaine arrivée : ${esc(longDate(k.nextCheckin))}${k.nextPersons ? `, ${k.nextPersons} personnes` : ""}${k.nextUnitName && k.nextUnitName !== k.unitName ? ` (${esc(k.nextUnitName)})` : ""}.</p>`
    : "<p>Pas d'arrivée prévue ensuite.</p>";
  return `<article class="job${done ? " done" : ""}">
  <h3>${title}</h3>
  <p>Départ ${k.dueDate === today ? "aujourd'hui" : "le " + esc(longDate(k.dueDate))}${k.dueTime ? `, ${esc(hour(k.dueTime))}` : ""}.</p>
  ${next}
  ${k.assignee ? `<p>Pour : <b>${esc(k.assignee)}</b></p>` : ""}
  ${k.note ? `<p class="note">Note : ${esc(k.note)}</p>` : ""}
  <form method="post" action="/t/${esc(token)}/${k.id}">
    <input type="hidden" name="etat" value="${done ? "a_faire" : "fait"}">
    <button type="submit" class="tick" aria-pressed="${done}">${done ? "✓ Ménage fait — toucher pour annuler" : "Marquer le ménage comme fait"}</button>
  </form>
</article>`;
}

function page(label: string, token: string, tasks: TaskRow[], today: string, flash: string): string {
  const byDay = new Map<string, TaskRow[]>();
  for (const k of tasks) byDay.set(k.dueDate, [...(byDay.get(k.dueDate) ?? []), k]);
  const sections = [...byDay]
    .map(([day, list]) => `<section><h2>${day === today ? "Aujourd'hui" : esc(cap(longDate(day)))}</h2>${list.map((k) => card(token, k, today)).join("")}</section>`)
    .join("");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Ménage — ${esc(label)}</title>
<style>
  :root { color-scheme: light; --ink: #1d2a24; --soft: #4a5a52; --line: #c9d3cd; --ok: #1f6b45; --warn: #8a4b00; }
  body { margin: 0; font: 18px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: #f6f4ef; }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.5rem; margin: 8px 0 4px; }
  h2 { font-size: 1.15rem; margin: 24px 0 8px; }
  h3 { font-size: 1.1rem; margin: 0 0 6px; }
  p { margin: 4px 0; }
  .lead { color: var(--soft); }
  .job { background: #fff; border: 2px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 0 0 12px; }
  .job.done { border-color: var(--ok); background: #eef7f1; }
  .tight { color: var(--warn); font-weight: 600; }
  .note { background: #fff8e6; padding: 6px 8px; border-radius: 8px; }
  form { margin: 12px 0 0; }
  .tick { display: block; width: 100%; min-height: 52px; font: inherit; font-weight: 700; border-radius: 10px; border: 2px solid var(--ok); background: var(--ok); color: #fff; cursor: pointer; }
  .done .tick { background: #fff; color: var(--ok); }
  .tick:focus-visible { outline: 3px solid #f2b705; outline-offset: 2px; }
  .flash { background: #eef7f1; border-left: 4px solid var(--ok); padding: 8px 12px; border-radius: 6px; }
  .empty { background: #fff; border-radius: 12px; padding: 16px; }
</style>
</head>
<body>
<main>
<h1>Ménage</h1>
<p class="lead">Lien de ${esc(label)}. Touchez la case quand la maison est prête : l'équipe le voit tout de suite.</p>
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ""}
${sections || `<p class="empty">Aucun ménage prévu dans les deux semaines.</p>`}
</main>
</body>
</html>`;
}

function gone(): Response {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Lien coupé</title><body style="font:18px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 16px"><h1>Ce lien ne marche plus</h1><p>Il a été coupé ou il est incomplet. Demandez un nouveau lien à l'équipe.</p></body></html>`,
    { status: 404, headers: PAGE_HEADERS },
  );
}

async function linkTasks(db: D1Database, propertyId: number | null, today: string): Promise<TaskRow[]> {
  const ids = propertyId ? [propertyId] : (await listProperties(db)).map((p) => p.id);
  return listTasks(db, { propertyIds: ids, from: addDays(today, -PAST_DAYS), to: addDays(today, AHEAD_DAYS + 1) });
}

export function registerTaskShareRoutes(router: Router): void {
  router.get("/t/:token", async (_req, env, p, url) => {
    const link = await resolveShareLink(env.DB, p.token ?? "");
    if (!link) return gone();
    const today = todayInZone();
    await touchShareLink(env.DB, link.id);
    const tasks = await linkTasks(env.DB, link.propertyId, today);
    const flash = url.searchParams.get("ok") === "fait" ? "C'est noté : ménage fait." : url.searchParams.get("ok") === "a_faire" ? "C'est noté : ménage remis à faire." : "";
    return new Response(page(link.label, p.token ?? "", tasks, today, flash), { headers: PAGE_HEADERS });
  });

  router.post("/t/:token/:task", async (req, env, p) => {
    const link = await resolveShareLink(env.DB, p.token ?? "");
    if (!link) return gone();
    const taskId = Math.floor(Number(p.task));
    const today = todayInZone();
    const task = Number.isInteger(taskId) && taskId > 0 ? await getTask(env.DB, taskId) : null;
    // La tâche doit être dans ce que le lien montre : domaine et fenêtre.
    const visible =
      !!task &&
      task.status !== "annule" &&
      (link.propertyId == null || task.propertyId === link.propertyId) &&
      task.dueDate >= addDays(today, -PAST_DAYS) &&
      task.dueDate <= addDays(today, AHEAD_DAYS);
    if (!visible) return apiError(404, "ménage introuvable pour ce lien");
    let etat = "";
    try {
      etat = String((await req.formData()).get("etat") ?? "");
    } catch {
      etat = "";
    }
    if (etat !== "fait" && etat !== "a_faire") return apiError(400, "état attendu : fait ou a_faire");
    const by = `lien:${link.label}`;
    await updateTask(env.DB, task.id, { status: etat }, by);
    await audit(env.DB, "public", "task.share.update", `task:${task.id}`, { status: etat, lien: link.id });
    return new Response(null, { status: 303, headers: { location: `/t/${p.token}?ok=${etat}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  });
}
