// Formes des réponses de l'API admin, réduites à ce que le connecteur lit.
// Source : src/db/repo.ts et src/api/admin.ts du Worker.

export interface Booking {
  id: number;
  reference: string;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  guestId: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  checkin: string;
  checkout: string;
  adults: number;
  children: number;
  status: "pending" | "confirmed" | "cancelled";
  holdExpiresAt: string | null;
  source: string;
  channelLabel: string | null;
  totalCents: number;
  depositCents: number;
  paidCents: number;
  balanceDueDate: string | null;
  promoCode: string | null;
  guestNotes: string | null;
  internalNotes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface Payment {
  id: number;
  bookingId: number;
  kind: string;
  method: string;
  amountCents: number;
  status: string;
  outcome: "expired" | "superseded" | null;
  receivedAt: string | null;
  createdAt: string;
  bookingReference?: string;
}

export interface EmailLog {
  id: number;
  kind: string;
  status: string;
  subject: string;
  createdAt: string;
}

export interface Audit {
  actor: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface BookingDetail {
  booking: Booking;
  payments: Payment[];
  emails: EmailLog[];
  history: Audit[];
}

export interface QuoteLine {
  kind: string;
  label: string;
  amountCents: number;
}

export interface Quote {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nights: number;
  minNights: number;
  checkinDays: number[] | null;
  lines: QuoteLine[];
  accommodationCents: number;
  discountCents: number;
  cleaningFeeCents: number;
  optionsCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  depositPct: number;
  balanceCents: number;
  balanceDueDate: string | null;
  cautionCents: number;
  promoApplied: string | null;
}

export interface Conflict {
  reference: string;
  unitName: string;
  checkin: string;
  checkout: string;
  status: string;
  viaLink: boolean;
}

export interface QuoteResponse {
  unit: { id: number; name: string };
  quote: Quote;
  availability: { available: boolean; conflicts: Conflict[] };
}

export interface Message {
  id: number;
  propertyId: number | null;
  direction: "in" | "out";
  channel: string;
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string;
  bodyText: string;
  bookingId: number | null;
  bookingReference: string | null;
  status: string;
  delivery: string | null;
  receivedAt: string;
}

export interface ManualBlock {
  id: number;
  unitId: number;
  unitName?: string;
  propertyId?: number;
  checkin: string;
  checkout: string;
  reason: string;
  createdBy: string;
}

export interface Overview {
  property: { id: number; name: string };
  today: string;
  alerts: {
    overdueBalances: unknown[];
    linkAlerts: unknown[];
    feedAlerts: { id: number; name: string; status: string }[];
    activeHolds: { id: number; reference: string; unitName: string; holdExpiresAt: string | null }[];
    newEmails: number;
  };
  health: {
    orphanPayments: { reference: string; amountCents: number }[];
    overpaidBookings: { reference: string; overpaidCents: number }[];
    failedEmails: { reference: string | null; kind: string; createdAt: string }[];
    recentErrors: { action: string; createdAt: string }[];
    beds24LastPull: string | null;
    beds24StaleHours: number | null;
    beds24Stale: boolean;
    drift: { label: string; detail: string }[];
    ok: boolean;
  };
}
