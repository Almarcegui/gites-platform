// Lectures des écrans de réglages (une par route de l'API admin).
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { Planning, RateCalendarUnit, UnitLink } from "../../api/types";
import type { FullSettings, PropertyFull, RateRule, Season, UnitFull } from "../../api/types2";

export function useUnitsFull(propertyId: number | undefined) {
  return useQuery({
    queryKey: ["units", propertyId],
    queryFn: () => api<{ units: UnitFull[]; links: UnitLink[] }>("/units", { query: { property: propertyId } }),
    enabled: propertyId != null,
  });
}

export function useSeasons(propertyId: number | undefined) {
  return useQuery({
    queryKey: ["seasons", propertyId],
    queryFn: () => api<{ seasons: Season[] }>("/seasons", { query: { property: propertyId } }).then((r) => r.seasons),
    enabled: propertyId != null,
  });
}

export function useRules(propertyId: number | undefined) {
  return useQuery({
    queryKey: ["rate-rules", propertyId],
    queryFn: () => api<{ rules: RateRule[] }>("/rate-rules", { query: { property: propertyId } }).then((r) => r.rules),
    enabled: propertyId != null,
  });
}

export function useRateCalendar(propertyId: number | undefined, from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ["rates", propertyId, from, to],
    queryFn: () => api<{ units: RateCalendarUnit[] }>("/rate-calendar", { query: { property: propertyId, from, to } }).then((r) => r.units),
    enabled: enabled && propertyId != null,
  });
}

export function usePlanning(propertyId: number | undefined, from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ["planning", propertyId, from, to],
    queryFn: () => api<Planning>("/planning", { query: { property: propertyId, from, to } }),
    enabled: enabled && propertyId != null,
  });
}

export function useSettingsFull(propertyId: number | undefined) {
  return useQuery({
    queryKey: ["settings-full", propertyId],
    queryFn: () => api<{ property: PropertyFull; settings: FullSettings; units: UnitFull[] }>("/settings", { query: { property: propertyId } }),
    enabled: propertyId != null,
  });
}
