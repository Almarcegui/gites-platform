// Ménage (plan v4, fonction 1) : les tâches viennent du serveur (migration
// 0022), générées par les départs. Ici : la forme d'affichage et l'écriture
// de l'état « fait ».
import type { IsoDate, Task } from "../api/types";

export interface CleaningItem {
  key: string;
  task: Task;
  unitName: string;
  isComposite: boolean;
  date: IsoDate;
  time: string;
  next: { checkin: IsoDate; unitName: string; persons: number; checkinTime: string } | null;
  /** Nouveaux voyageurs le jour même : le ménage a une heure limite. */
  tight: boolean;
  done: boolean;
}

export function toCleaningItem(t: Task, fallbackCheckout = "10:00", fallbackCheckin = "16:00"): CleaningItem {
  const next = t.nextCheckin
    ? { checkin: t.nextCheckin, unitName: t.nextUnitName ?? "", persons: t.nextPersons ?? 0, checkinTime: t.nextCheckinTime ?? fallbackCheckin }
    : null;
  return {
    key: String(t.id),
    task: t,
    unitName: t.unitName,
    isComposite: t.isComposite,
    date: t.dueDate,
    time: t.dueTime ?? fallbackCheckout,
    next,
    tight: !!next && next.checkin === t.dueDate,
    done: t.status === "fait",
  };
}

/** Ménages par réservation, pour la pastille de la grille. */
export function tasksByBooking(tasks: Task[] | undefined): Map<number, Task> {
  const m = new Map<number, Task>();
  for (const t of tasks ?? []) if (t.bookingId != null && t.status !== "annule") m.set(t.bookingId, t);
  return m;
}
