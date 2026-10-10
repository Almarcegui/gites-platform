import { useLingui } from "@lingui/react/macro";

import { CalendarView } from "../calendar/CalendarView";

export function CalendarPage() {
  const { t } = useLingui();
  return <CalendarView title={t`Calendrier`} />;
}
