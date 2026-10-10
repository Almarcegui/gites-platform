// Formulaire de paiement intégré (Stripe Payment Element) — issue #26.
//
// Partagé par le tunnel (`book.js`, étape 4) et par le voucher
// (`voucher.html`, paiement du solde) : les deux pages montent le MÊME
// formulaire, avec la même gestion d'échec et le même thème.
//
// Trois règles tiennent ce module :
//
//  1. `js.stripe.com` n'est chargé QUE si le serveur a annoncé une clé publique
//     (`GET /api/public/payment-config`). Sans clé Stripe configurée, aucune
//     requête ne part vers Stripe et c'est le simulateur local qui s'affiche,
//     inchangé.
//  2. Le montant n'est jamais décidé ici. Il est figé côté serveur dans le
//     PaymentIntent ; le `client_secret` ne permet que de confirmer CE
//     paiement-là. Ce que la page affiche est un libellé, pas une instruction.
//  3. Le retour navigateur ne prouve rien. C'est le webhook qui crédite. Un
//     échec laisse donc la réservation intacte : le blocage de 30 minutes
//     continue de courir et le bouton « Réessayer » relance la même intention.

import { LANG, t } from "./i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Configuration publique du paiement. Un échec réseau se lit comme « pas de
 *  paiement intégré » : l'appelant retombe sur son chemin de redirection. */
export async function paymentConfig() {
  try {
    const res = await fetch("/api/public/payment-config");
    if (!res.ok) return { enabled: false };
    return await res.json();
  } catch {
    return { enabled: false };
  }
}

/** Charge `js.stripe.com/v3/` une seule fois par page, à la demande. */
let stripeJsPromise = null;
export function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://js.stripe.com/v3/";
    tag.async = true;
    tag.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error(t("module de paiement indisponible"))));
    tag.onerror = () => reject(new Error(t("module de paiement inaccessible")));
    document.head.appendChild(tag);
  });
  return stripeJsPromise;
}

/** Thème sobre du site : mêmes couleurs et même typographie que `book.css`,
 *  pour que le formulaire ne se lise pas comme une pièce rapportée. */
function appearance() {
  return {
    theme: "flat",
    variables: {
      colorPrimary: "#2F5D3F",
      colorBackground: "#FFFFFF",
      colorText: "#1F2937",
      colorTextSecondary: "#4B5563",
      colorDanger: "#991B1B",
      fontFamily: "-apple-system, 'Inter', 'Segoe UI', sans-serif",
      fontSizeBase: "14px",
      borderRadius: "6px",
      spacingUnit: "4px",
    },
    rules: {
      ".Input": { border: "1px solid #E5E1D8", boxShadow: "none", padding: "9px 10px" },
      ".Input:focus": { border: "1px solid #2F5D3F", outline: "2px solid #2F5D3F", outlineOffset: "2px" },
      ".Label": { color: "#4B5563", fontSize: "11px", textTransform: "uppercase", letterSpacing: ".5px" },
    },
  };
}

/**
 * Monte le formulaire de paiement dans `container`.
 *
 * @param {HTMLElement} container  élément qui reçoit le formulaire (vidé)
 * @param {object} opts
 *   - `publishableKey`  clé publique rendue par /api/public/payment-config
 *   - `clientSecret`    secret du PaymentIntent créé par le serveur
 *   - `returnUrl`       où Stripe ramène le client (Bancontact redirige)
 *   - `amountLabel`     montant déjà formaté, pour le libellé du bouton
 *   - `title`           titre de la carte
 * @returns {Promise<void>} résolue quand le formulaire est monté et utilisable.
 */
export async function mountPayment(container, opts) {
  const Stripe = await loadStripeJs();
  const stripe = Stripe(opts.publishableKey);
  const elements = stripe.elements({
    clientSecret: opts.clientSecret,
    appearance: appearance(),
    locale: LANG === "nl" ? "nl" : "fr",
  });

  container.hidden = false;
  container.innerHTML = `
    <h3>${esc(opts.title || t("Paiement sécurisé"))}</h3>
    <div id="peMount"></div>
    <div id="peMsg" role="alert" aria-live="assertive"></div>
    <button class="btn big" id="pePay" style="margin-top:14px">${opts.amountLabel ? t("Payer {montant}", { montant: esc(opts.amountLabel) }) : t("Payer")}</button>
    <p class="small muted" style="margin-top:8px">${t("Carte bancaire, Bancontact, Apple&nbsp;Pay et Google&nbsp;Pay. Paiement traité par Stripe — vos données bancaires ne transitent pas par notre serveur.")}</p>`;

  const payment = elements.create("payment", { layout: "tabs" });
  payment.mount(container.querySelector("#peMount"));

  const btn = container.querySelector("#pePay");
  const msg = container.querySelector("#peMsg");

  const fail = (text) => {
    // Le hold n'est pas perdu : on le dit, sinon le client referme l'onglet.
    msg.innerHTML = `<div class="note bad">${esc(text)}<br><span class="small">${t("Votre créneau reste bloqué — vous pouvez réessayer, ou choisir un autre moyen de paiement.")}</span></div>`;
    btn.disabled = false;
    btn.textContent = opts.amountLabel ? t("Réessayer le paiement de {montant}", { montant: opts.amountLabel }) : t("Réessayer le paiement");
    msg.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  btn.addEventListener("click", async () => {
    msg.innerHTML = "";
    btn.disabled = true;
    btn.textContent = t("Paiement en cours…");
    let result;
    try {
      result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: opts.returnUrl },
      });
    } catch (e) {
      fail(e?.message || t("Le paiement n'a pas pu être lancé."));
      return;
    }
    // On n'arrive ici QUE si Stripe n'a pas redirigé : carte refusée, champ
    // invalide, réseau. Les moyens à redirection (Bancontact) ont déjà quitté
    // la page, et c'est le webhook — pas ce retour — qui créditera.
    if (result?.error) {
      fail(result.error.message || t("Le paiement n'a pas abouti."));
      return;
    }
    btn.textContent = t("Paiement confirmé — redirection…");
  });
}
