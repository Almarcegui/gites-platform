// Domaines et hébergements : lus une fois puis gardés 5 minutes, pour qu'on
// puisse dire « la Scierie » au lieu de « unité 2 ».

import type { GitesClient } from "./client.js";

export interface Property {
  id: number;
  name: string;
  slug: string;
  active: boolean;
}
export interface Unit {
  id: number;
  propertyId: number;
  slug: string;
  name: string;
  capacityBase: number;
  capacityMax: number;
  isComposite: boolean;
  active: boolean;
}
export interface Link {
  unitId: number;
  blocksUnitId: number;
}

export class ResolutionError extends Error {}

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(le|la|les|l) /, "");
}

export class Referentiel {
  #at = 0;
  #data: { properties: Property[]; units: Unit[]; links: Link[] } | null = null;

  constructor(
    private readonly client: GitesClient,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async load(): Promise<{ properties: Property[]; units: Unit[]; links: Link[] }> {
    if (this.#data && Date.now() - this.#at < this.ttlMs) return this.#data;
    const { properties } = await this.client.get<{ properties: Property[] }>("/api/admin/properties");
    const units: Unit[] = [];
    const links: Link[] = [];
    for (const p of properties) {
      const r = await this.client.get<{ units: Unit[]; links: Link[] }>(`/api/admin/units?property=${p.id}`);
      units.push(...r.units.map((u) => ({ ...u, propertyId: u.propertyId ?? p.id })));
      links.push(...(r.links ?? []));
    }
    this.#data = { properties, units, links };
    this.#at = Date.now();
    return this.#data;
  }

  /** Domaine par id ou par nom (« Pré Moré », « Moulin »). */
  async property(q: string | number | undefined): Promise<Property | null> {
    if (q === undefined || q === "") return null;
    const { properties } = await this.load();
    const asNum = Number(q);
    if (Number.isInteger(asNum) && asNum > 0) {
      const p = properties.find((x) => x.id === asNum);
      if (p) return p;
    }
    const n = normalize(String(q));
    const hits = properties.filter((p) => normalize(p.name).includes(n) || normalize(p.slug).includes(n));
    if (hits.length === 1) return hits[0]!;
    const list = properties.map((p) => `${p.name} (id ${p.id})`).join(", ");
    if (!hits.length) throw new ResolutionError(`domaine « ${q} » introuvable — domaines connus : ${list}`);
    throw new ResolutionError(`domaine « ${q} » ambigu — préciser parmi : ${hits.map((p) => `${p.name} (id ${p.id})`).join(", ")}`);
  }

  async propertiesFor(q: string | number | undefined): Promise<Property[]> {
    const one = await this.property(q);
    if (one) return [one];
    return (await this.load()).properties.filter((p) => p.active !== false);
  }

  /** Hébergement par id, slug ou nom. Correspondance exacte d'abord (« Scierie »
   *  ne doit pas attraper « Maison du Scieur »), puis par inclusion. */
  async unit(q: string | number): Promise<Unit> {
    const { units } = await this.load();
    const asNum = Number(q);
    if (Number.isInteger(asNum) && asNum > 0) {
      const u = units.find((x) => x.id === asNum);
      if (u) return u;
    }
    const n = normalize(String(q));
    const exact = units.filter((u) => normalize(u.name) === n || normalize(u.slug) === n);
    if (exact.length === 1) return exact[0]!;
    const hits = exact.length ? exact : units.filter((u) => normalize(u.name).includes(n) || normalize(u.slug).includes(n));
    if (hits.length === 1) return hits[0]!;
    const list = (hits.length ? hits : units).map((u) => `${u.name} (id ${u.id})`).join(", ");
    if (!hits.length) throw new ResolutionError(`hébergement « ${q} » introuvable — hébergements connus : ${list}`);
    throw new ResolutionError(`hébergement « ${q} » ambigu — préciser parmi : ${list}`);
  }

  /** Hébergements rendus indisponibles par une occupation de `unitId` (lui compris). */
  async impacted(unitId: number): Promise<Unit[]> {
    const { units, links } = await this.load();
    const ids = new Set([unitId, ...links.filter((l) => l.unitId === unitId).map((l) => l.blocksUnitId)]);
    return units.filter((u) => ids.has(u.id));
  }
}
