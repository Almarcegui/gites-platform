// Back-office — section « Accès de service » de la page Utilisateurs : les clés
// d'API de Claude et des scripts du Mac (sans compte humain). La clé n'est
// affichée qu'une fois, à la création ; seule son empreinte est gardée.
// Création et révocation : depuis une session humaine seulement (le serveur le vérifie).

import { api, copyText, esc, openModal, toast } from "./app.js";

export async function renderServiceKeys(container) {
  let data;
  try {
    data = await api("/api/admin/service-keys");
  } catch (e) {
    container.innerHTML = `<div class="card"><h3>Accès de service</h3><p class="muted">Indisponible : ${esc(e.message)}</p></div>`;
    return;
  }
  const rows = data.keys.map((k) => `
    <tr>
      <td><b>${esc(k.name)}</b><div class="small mono">${esc(k.keyHint)}</div></td>
      <td>${k.revokedAt ? `<span class="tag t-warn">révoquée</span>` : `<span class="tag t-ok">active</span>`}</td>
      <td class="small">${esc(k.createdAt.slice(0, 16))}${k.createdBy ? ` · ${esc(k.createdBy)}` : ""}</td>
      <td class="small">${k.lastUsedAt ? esc(k.lastUsedAt.slice(0, 16)) : "jamais"}</td>
      <td class="r">${k.revokedAt ? "" : `<button class="btn o sm kRevoke" data-id="${k.id}" data-name="${esc(k.name)}">⛔ Révoquer</button>`}</td>
    </tr>`).join("");
  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <h3>Accès de service (${data.keys.filter((k) => !k.revokedAt).length} actif·s)</h3>
        <button class="btn sm" id="kAdd">➕ Créer une clé</button>
      </div>
      <p class="small muted">Pour Claude et les scripts du Mac, sans compte humain : mêmes droits qu'un compte,
        présentés en <span class="mono">Authorization: Bearer svc:&lt;clé&gt;</span>. La clé n'est affichée
        qu'une fois ; une clé révoquée cesse de fonctionner tout de suite.</p>
      ${data.keys.length
        ? `<table><tr><th>Nom</th><th>État</th><th>Créée</th><th>Dernier usage</th><th class="r"></th></tr>${rows}</table>`
        : `<p class="muted">Aucune clé pour l'instant.</p>`}
    </div>`;

  container.querySelector("#kAdd").addEventListener("click", async () => {
    const name = prompt("Nom de la clé (ex. claude-mac, script-sauvegarde) :");
    if (!name) return;
    try {
      const r = await api("/api/admin/service-keys", { method: "POST", body: { name: name.trim().toLowerCase() } });
      const bg = openModal(`
        <h3>Clé créée ✅</h3>
        <p>Clé <b>${esc(r.serviceKey.name)}</b> (affichée une seule fois) — à coller dans
          <span class="mono">~/.config/gites/service.env</span> (GITES_SERVICE_KEY) :</p>
        <p class="mono" style="font-size:14px;background:#f5f5f2;padding:10px 12px;border-radius:8px;user-select:all;word-break:break-all">${esc(r.key)}</p>
        <p><button class="btn sm" id="kCopy">Copier</button> <button class="btn o sm x">Fermer</button></p>`);
      bg.querySelector("#kCopy").addEventListener("click", () => { copyText(r.key); toast("Copié"); });
      bg.querySelector(".x").addEventListener("click", () => location.reload());
    } catch (e) { toast(e.message, true); }
  });
  container.querySelectorAll(".kRevoke").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Révoquer la clé « ${b.dataset.name} » ? Ce qui l'utilise cessera de fonctionner immédiatement.`)) return;
    try {
      await api(`/api/admin/service-keys/${b.dataset.id}/revoke`, { method: "POST" });
      toast("Clé révoquée");
      location.reload();
    } catch (e) { toast(e.message, true); }
  }));
}
