// Journal des recherches (issue #36) — écriture et lecture.
//
// Le back-office sait ce qui a été vendu, jamais ce qui a été cherché. Une
// recherche non enregistrée est perdue pour toujours : c'est la seule donnée du
// système qui ne se reconstitue pas après coup.
//
// DEUX RÈGLES NON NÉGOCIABLES :
//
// 1. Aucune donnée identifiante. Ni IP (même tronquée), ni e-mail, ni
//    empreinte de navigateur, ni identifiant de session. On enregistre ce qui a
//    été cherché, jamais qui a cherché — cf. l'en-tête de la migration 0013.
//
// 2. Une écriture de mesure ne casse JAMAIS la fonctionnalité mesurée. Toute
//    erreur ici est avalée : une recherche de disponibilité qui échouerait
//    parce que sa statistique n'a pas pu s'écrire serait une régression
//    absurde. Quand le contexte d'exécution du Worker est disponible,
//    l'écriture part même en dehors du chemin de réponse (waitUntil), comme le
//    fait déjà le push Beds24 temps réel.

import { diffDays, type IsoDate } from "../core/dates";
import type { SearchLogEntry } from "../core/stats";

export interface SearchLogInput {
  propertyId: number;
  /** Hébergement visé, ou null pour une recherche sur tout le domaine. */
  unitId?: number | null;
  stage: "search" | "quote";
  checkin: IsoDate;
  checkout: IsoDate;
  adults: number;
  children: number;
  /** Nombre d'hébergements réservables trouvés (0 = recherche infructueuse). */
  results: number;
}

/** Enregistre une recherche. Ne rejette jamais. */
export function logSearch(
  db: D1Database,
  execCtx: ExecutionContext | undefined,
  input: SearchLogInput,
): Promise<void> | undefined {
  const write = async (): Promise<void> => {
    try {
      const nights = Math.max(0, diffDays(input.checkin, input.checkout));
      await db
        .prepare(
          `INSERT INTO search_log (property_id, unit_id, stage, checkin, checkout, nights, adults, children, results, found)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          input.propertyId,
          input.unitId ?? null,
          input.stage,
          input.checkin,
          input.checkout,
          nights,
          input.adults,
          input.children,
          input.results,
          input.results > 0 ? 1 : 0,
        )
        .run();
    } catch {
      // Mesurer ne doit pas pouvoir casser ce qui est mesuré.
    }
  };
  if (execCtx) {
    execCtx.waitUntil(write());
    return undefined;
  }
  return write();
}

interface Raw {
  [key: string]: unknown;
}

/** Recherches d'une année, pour la synthèse du back-office. */
export async function listSearchLog(
  db: D1Database,
  opts: { propertyId: number; year: number; stage?: "search" | "quote" },
): Promise<SearchLogEntry[]> {
  const from = `${opts.year}-01-01`;
  const to = `${opts.year + 1}-01-01`;
  const { results } = await db
    .prepare(
      `SELECT checkin, checkout, nights, adults, children, found
         FROM search_log
        WHERE property_id = ?1 AND created_at >= ?2 AND created_at < ?3
          AND (?4 IS NULL OR stage = ?4)
        ORDER BY created_at`,
    )
    .bind(opts.propertyId, from, to, opts.stage ?? null)
    .all();
  return (results as Raw[]).map((r) => ({
    checkin: String(r.checkin),
    checkout: String(r.checkout),
    nights: Number(r.nights),
    adults: Number(r.adults),
    children: Number(r.children),
    found: Number(r.found) === 1,
  }));
}

/** Effectifs par étape — les deux premiers barreaux de l'entonnoir. */
export async function countSearchStages(
  db: D1Database,
  opts: { propertyId: number; year: number },
): Promise<{ searches: number; quotes: number }> {
  const from = `${opts.year}-01-01`;
  const to = `${opts.year + 1}-01-01`;
  const { results } = await db
    .prepare(
      `SELECT stage, COUNT(*) AS n
         FROM search_log
        WHERE property_id = ?1 AND created_at >= ?2 AND created_at < ?3
        GROUP BY stage`,
    )
    .bind(opts.propertyId, from, to)
    .all();
  const byStage = new Map((results as Raw[]).map((r) => [String(r.stage), Number(r.n)]));
  return { searches: byStage.get("search") ?? 0, quotes: byStage.get("quote") ?? 0 };
}

/** Réservations directes de l'année, par statut — les deux derniers barreaux.
 *
 *  Filtre `source = 'direct'` : une réservation venue d'un canal OTA ou d'un
 *  import n'a jamais traversé le tunnel, la compter fabriquerait un taux de
 *  conversion supérieur à la réalité. */
export async function countDirectBookings(
  db: D1Database,
  opts: { propertyId: number; year: number },
): Promise<{ started: number; confirmed: number }> {
  const from = `${opts.year}-01-01`;
  const to = `${opts.year + 1}-01-01`;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS started,
              SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
         FROM bookings b
         JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = ?1 AND b.source = 'direct'
          AND b.created_at >= ?2 AND b.created_at < ?3`,
    )
    .bind(opts.propertyId, from, to)
    .first<{ started: number; confirmed: number | null }>();
  return { started: Number(row?.started ?? 0), confirmed: Number(row?.confirmed ?? 0) };
}
