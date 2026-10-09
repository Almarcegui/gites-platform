// Dates du connecteur : ISO AAAA-MM-JJ, journée civile de Bruxelles (même
// fuseau que la plateforme — core/dates.ts du Worker).

export const ZONE = "Europe/Brussels";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function todayInZone(now: Date = new Date()): string {
  // en-CA formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = dimanche … 6 = samedi. */
export function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function nights(checkin: string, checkout: string): number {
  return Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000);
}

const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

/** « ven. 12/06/2026 » — lisible à l'écran comme à voix haute. */
export function frDate(iso: string): string {
  return `${JOURS[weekday(iso)]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export type Periode = "aujourdhui" | "demain" | "ce_week_end" | "week_end_prochain" | "7_jours" | "30_jours";

/** Fenêtre [du, au] INCLUSIVE. Le week-end court du vendredi au lundi (les
 *  arrivées du vendredi et les départs du lundi matin en font partie). Le
 *  samedi et le dimanche, « ce week-end » est celui qui est en cours. */
export function periodWindow(p: Periode, today: string): { du: string; au: string } {
  switch (p) {
    case "aujourdhui":
      return { du: today, au: today };
    case "demain":
      return { du: addDays(today, 1), au: addDays(today, 1) };
    case "7_jours":
      return { du: today, au: addDays(today, 6) };
    case "30_jours":
      return { du: today, au: addDays(today, 29) };
    case "ce_week_end":
    case "week_end_prochain": {
      const wd = weekday(today);
      // Vendredi du week-end « courant » : dimanche → -2, samedi → -1, sinon le prochain vendredi.
      const toFriday = wd === 0 ? -2 : wd === 6 ? -1 : (5 - wd + 7) % 7;
      let friday = addDays(today, toFriday);
      if (p === "week_end_prochain") friday = addDays(friday, 7);
      const du = friday < today ? today : friday;
      return { du, au: addDays(friday, 3) };
    }
  }
}

export function euros(cents: number): string {
  const v = (cents / 100).toFixed(2).replace(".", ",");
  const [ent, dec] = v.split(",");
  const grouped = (ent ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped},${dec} €`;
}
