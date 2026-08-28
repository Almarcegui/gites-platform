// Registre des personnes hébergées — logique pure (issue #84).
//
// Aucun I/O : validation d'une déclaration d'occupant et calcul de la date
// butoir de conservation. Le SQL vit dans src/db/repo.ts, l'orchestration de
// la purge dans src/services/guest-register.ts.

import { isIsoDate, type IsoDate } from "./dates";

/** Durée de conservation du registre, en années. Au-delà, la purge planifiée
 *  efface les lignes — c'est le seul DELETE du projet sur cette table. */
export const GUEST_REGISTER_RETENTION_YEARS = 7;

/** Nombre maximal d'occupants déclarés en une seule requête (garde-fou de
 *  saisie : on remplit un formulaire à l'arrivée, pas un fichier). */
export const MAX_GUEST_ENTRIES_PER_REQUEST = 30;

/** Amplitude maximale d'un export CSV, en jours : un peu plus que la durée de
 *  conservation, pour qu'une demande « tout le registre » passe en une fois. */
export const MAX_REGISTER_EXPORT_DAYS = 3000;

export const GUEST_ID_TYPES = ["id_card", "passport", "residence_permit", "other"] as const;
export type GuestIdType = (typeof GUEST_ID_TYPES)[number];

/** Libellés français des types de pièce — partagés par l'export CSV et le
 *  back-office, pour que les deux disent la même chose. */
export const GUEST_ID_TYPE_FR: Record<GuestIdType, string> = {
  id_card: "Carte d'identité",
  passport: "Passeport",
  residence_permit: "Titre de séjour",
  other: "Autre",
};

export interface GuestRegisterEntry {
  lastName: string;
  firstName: string;
  birthDate: IsoDate;
  nationality: string;
  idType: GuestIdType;
  idNumber: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  /** Ligne que celle-ci remplace (correction). Jamais de réécriture. */
  supersedesId: number | null;
}

export type ParsedEntry =
  | { ok: true; entry: GuestRegisterEntry }
  | { ok: false; message: string };

/** Date la plus ancienne acceptée comme date de naissance — au-delà, c'est une
 *  faute de frappe, pas un centenaire. */
const MIN_BIRTH_DATE = "1900-01-01";

/** Caractères invisibles retirés de toute saisie libre :
 *  contrôles ASCII (retour chariot, tabulation), marques de direction et
 *  surcharges bidirectionnelles, BOM. Les premiers casseraient une ligne du
 *  CSV remis à un tiers ; les secondes permettent d'y afficher un nom à
 *  l'envers ou de masquer la fin d'un numéro de pièce (contre-review du
 *  2026-08-28). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Nettoie une saisie libre : caractères invisibles retirés, espaces
 *  normalisés. */
function clean(raw: unknown): string {
  return String(raw ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

type Field = { ok: true; value: string } | { ok: false; message: string };

function textField(raw: unknown, label: string, min: number, max: number): Field {
  const value = clean(raw);
  if (value.length < min) return { ok: false, message: `${label} requis` };
  if (value.length > max) return { ok: false, message: `${label} trop long (max ${max} caractères)` };
  return { ok: true, value };
}

/** Valide UNE déclaration d'occupant. `today` sert à refuser une date de
 *  naissance dans le futur — la seule borne temporelle qui ait un sens ici. */
export function parseGuestEntry(raw: unknown, today: IsoDate): ParsedEntry {
  if (raw == null || typeof raw !== "object") return { ok: false, message: "occupant invalide" };
  const r = raw as Record<string, unknown>;

  const lastName = textField(r.lastName, "nom", 1, 120);
  if (!lastName.ok) return lastName;
  const firstName = textField(r.firstName, "prénom", 1, 120);
  if (!firstName.ok) return firstName;
  const nationality = textField(r.nationality, "nationalité", 2, 60);
  if (!nationality.ok) return nationality;
  const idNumber = textField(r.idNumber, "numéro de pièce d'identité", 3, 60);
  if (!idNumber.ok) return idNumber;

  const idType = clean(r.idType);
  if (!(GUEST_ID_TYPES as readonly string[]).includes(idType)) {
    return { ok: false, message: "type de pièce d'identité inconnu" };
  }

  const birthDate = clean(r.birthDate);
  if (!isIsoDate(birthDate)) return { ok: false, message: "date de naissance invalide (format AAAA-MM-JJ)" };
  if (birthDate < MIN_BIRTH_DATE || birthDate > today) return { ok: false, message: "date de naissance hors bornes" };

  const arrivalDate = clean(r.arrivalDate);
  const departureDate = clean(r.departureDate);
  if (!isIsoDate(arrivalDate) || !isIsoDate(departureDate)) {
    return { ok: false, message: "dates de séjour invalides (format AAAA-MM-JJ)" };
  }
  if (arrivalDate >= departureDate) return { ok: false, message: "la date de départ doit suivre la date d'arrivée" };
  if (birthDate > arrivalDate) return { ok: false, message: "date de naissance postérieure à l'arrivée" };

  let supersedesId: number | null = null;
  if (r.supersedesId != null && r.supersedesId !== "") {
    const n = Math.floor(Number(r.supersedesId));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, message: "ligne à corriger invalide" };
    supersedesId = n;
  }

  return {
    ok: true,
    entry: {
      lastName: lastName.value,
      firstName: firstName.value,
      birthDate,
      nationality: nationality.value,
      idType: idType as GuestIdType,
      idNumber: idNumber.value,
      arrivalDate,
      departureDate,
      supersedesId,
    },
  };
}

/** Date butoir de conservation : tout séjour terminé AVANT cette date sort du
 *  registre. Le 29 février se normalise sur le 1er mars — un jour de plus de
 *  purge une année sur quatre, jamais un jour de moins de conservation. */
export function retentionCutoff(today: IsoDate, years: number = GUEST_REGISTER_RETENTION_YEARS): IsoDate {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const d = Number(today.slice(8, 10));
  return new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10) as IsoDate;
}
