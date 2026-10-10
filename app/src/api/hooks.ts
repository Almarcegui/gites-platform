// Lectures de l'API, mises en cache par TanStack Query. Après toute écriture,
// `useRefresh()` relit tout : l'écran ne montre jamais un état qu'il suppose.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { api } from "./client";
import type {
  BookingDetail,
  Guest,
  IsoDate,
  Message,
  Overview,
  Planning,
  Property,
  RateCalendarUnit,
  Unit,
  UnitLink,
} from "./types";
import { useScope } from "../lib/scope";

export interface Settings {
  checkinTime: string;
  checkoutTime: string;
  depositPct: number;
  balanceDueDays: number;
  holdMinutes: number;
}

export function useProperties() {
  return useQuery({ queryKey: ["properties"], queryFn: () => api<{ properties: Property[] }>("/properties").then((r) => r.properties), staleTime: 5 * 60_000 });
}

/** Domaines visés par le sélecteur (« Tous mes gîtes » ou un seul). */
export function useScopedProperties(): { properties: Property[]; isLoading: boolean; error: unknown } {
  const { scope } = useScope();
  const q = useProperties();
  const all = q.data ?? [];
  return { properties: scope === "all" ? all : all.filter((p) => p.id === scope), isLoading: q.isLoading, error: q.error };
}

export interface DomainData {
  property: Property;
  units: Unit[];
  links: UnitLink[];
  planning: Planning | undefined;
  settings: Settings | undefined;
}

/** Biens, liaisons, planning et horaires de chaque domaine visé, sur [from, to). */
export function useDomains(from: IsoDate, to: IsoDate): { domains: DomainData[]; isLoading: boolean; error: unknown } {
  const { properties, isLoading, error } = useScopedProperties();
  const units = useQueries({
    queries: properties.map((p) => ({
      queryKey: ["units", p.id],
      queryFn: () => api<{ units: Unit[]; links: UnitLink[] }>("/units", { query: { property: p.id } }),
      staleTime: 60_000,
    })),
  });
  const planning = useQueries({
    queries: properties.map((p) => ({
      queryKey: ["planning", p.id, from, to],
      queryFn: () => api<Planning>("/planning", { query: { property: p.id, from, to } }),
    })),
  });
  const settings = useQueries({
    queries: properties.map((p) => ({
      queryKey: ["settings", p.id],
      queryFn: () => api<{ settings: Settings }>("/settings", { query: { property: p.id } }).then((r) => r.settings),
      staleTime: 5 * 60_000,
    })),
  });
  const domains = properties.map((property, i) => ({
    property,
    units: (units[i]?.data?.units ?? []).filter((u) => u.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    links: units[i]?.data?.links ?? [],
    planning: planning[i]?.data,
    settings: settings[i]?.data,
  }));
  const all = [...units, ...planning, ...settings];
  return {
    domains,
    isLoading: isLoading || all.some((q) => q.isLoading),
    error: error ?? all.find((q) => q.error)?.error ?? null,
  };
}

export function useOverviews() {
  const { properties } = useScopedProperties();
  const qs = useQueries({
    queries: properties.map((p) => ({ queryKey: ["overview", p.id], queryFn: () => api<Overview>("/overview", { query: { property: p.id } }) })),
  });
  return qs.map((q) => q.data).filter((x): x is Overview => !!x);
}

export function useRates(propertyId: number, from: IsoDate, to: IsoDate, enabled: boolean) {
  return useQuery({
    queryKey: ["rates", propertyId, from, to],
    queryFn: () => api<{ units: RateCalendarUnit[] }>("/rate-calendar", { query: { property: propertyId, from, to } }).then((r) => r.units),
    enabled,
  });
}

export function useMessages(status?: "nouveau") {
  const { properties } = useScopedProperties();
  const { scope } = useScope();
  return useQuery({
    queryKey: ["messages", scope, status ?? "all"],
    queryFn: () =>
      api<{ messages: Message[] }>("/messages", { query: { property: scope === "all" ? undefined : scope, status } }).then((r) => r.messages),
    enabled: properties.length > 0,
  });
}

export function useBooking(id: number | null) {
  return useQuery({ queryKey: ["booking", id], queryFn: () => api<BookingDetail>(`/bookings/${id}`), enabled: id != null });
}

export function useGuest(id: number | null | undefined) {
  return useQuery({
    queryKey: ["guest", id],
    queryFn: () => api<{ guest: Guest }>(`/guests/${id}`).then((r) => r.guest),
    enabled: id != null,
  });
}

/** Relit tout ce que l'écran affiche, après une écriture. */
export function useRefresh(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "properties" });
  }, [qc]);
}
