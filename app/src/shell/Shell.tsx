import { Trans, useLingui } from "@lingui/react/macro";
import { Menu } from "@mantine/core";
import { IconAdjustmentsHorizontal, IconBrush, IconCalendar, IconCheck, IconHome, IconList, IconMessage, IconSun } from "@tabler/icons-react";
import { Link, Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { useMessages, useProperties } from "../api/hooks";
import { BookingPanel } from "../booking/BookingPanel";
import { useScope, type Scope } from "../lib/scope";
import { Confirm, hasUnsaved } from "../ui/kit";
import { SaleProvider } from "../sale/SaleFlow";

function DomainSelector() {
  const { t } = useLingui();
  const { scope, setScope: applyScope } = useScope();
  const [pending, setPending] = useState<Scope | null>(null);
  // Une saisie en cours dépend du domaine affiché : on demande avant d'en changer.
  const setScope = (s: Scope) => (s !== scope && hasUnsaved() ? setPending(s) : applyScope(s));
  const { data: properties = [] } = useProperties();
  const current = scope === "all" ? null : properties.find((p) => p.id === scope);
  const label = current ? current.name : t`Tous mes gîtes`;
  const detail = current ? (current.commune ?? "") : properties.map((p) => p.name.replace(/^(Les Gîtes du |Le )/, "")).join(t` et `);
  return (
    <Menu position="bottom-start" shadow="md" width={300}>
      <Menu.Target>
        <button className="dom" type="button" aria-label={t`Choisir le domaine affiché, actuellement : ${label}`}>
          <IconHome size={22} className="dom-ic" />
          <b>{label}</b> <small>{detail}</small>
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => setScope("all")} rightSection={scope === "all" ? <IconCheck size={18} /> : null} style={{ minHeight: 44 }}>
          <Trans>Tous mes gîtes</Trans>
        </Menu.Item>
        {properties.map((p) => (
          <Menu.Item key={p.id} onClick={() => setScope(p.id)} rightSection={scope === p.id ? <IconCheck size={18} /> : null} style={{ minHeight: 44 }}>
            {p.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
      <Confirm
        open={pending != null}
        title={t`Changer de domaine sans enregistrer ?`}
        text={t`Des modifications de cette page ne sont pas enregistrées. En changeant de domaine, elles seront perdues.`}
        yes={t`Changer sans enregistrer`}
        no={t`Rester sur ce domaine`}
        danger
        onYes={() => {
          if (pending != null) applyScope(pending);
          setPending(null);
        }}
        onNo={() => setPending(null)}
      />
    </Menu>
  );
}

function NavLink({ to, icon, children, badge }: { to: string; icon: ReactNode; children: ReactNode; badge?: number }) {
  return (
    <Link to={to} activeOptions={{ exact: to === "/", includeSearch: false }} activeProps={{ "aria-current": "page" }} search={(s: object) => s}>
      {icon}
      {children}
      {badge ? <span className="badge">{badge}</span> : null}
    </Link>
  );
}

function Items({ unread }: { unread: number }) {
  return (
    <>
      <NavLink to="/" icon={<IconSun size={22} />}>
        <Trans>Aujourd'hui</Trans>
      </NavLink>
      <NavLink to="/calendrier" icon={<IconCalendar size={22} />}>
        <Trans>Calendrier</Trans>
      </NavLink>
      <NavLink to="/reservations" icon={<IconList size={22} />}>
        <Trans>Réservations</Trans>
      </NavLink>
      <NavLink to="/messages" icon={<IconMessage size={22} />} badge={unread}>
        <Trans>Messages</Trans>
      </NavLink>
      <NavLink to="/menage" icon={<IconBrush size={22} />}>
        <Trans>Ménage</Trans>
      </NavLink>
    </>
  );
}

export function Shell() {
  const { t } = useLingui();
  const search = useSearch({ strict: false }) as { resa?: number };
  const navigate = useNavigate();
  const unread = useMessages("nouveau").data?.length ?? 0;
  return (
    <SaleProvider>
      <header className="top">
        <DomainSelector />
        <nav className="nav" aria-label={t`Menu principal`}>
          <Items unread={unread} />
        </nav>
        <Link to="/reglages" className="btn ghost set" activeProps={{ "aria-current": "page" }} aria-label={t`Réglages`}>
          <IconAdjustmentsHorizontal size={22} />
          <span>
            <Trans>Réglages</Trans>
          </span>
        </Link>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label={t`Menu principal`}>
        <Items unread={unread} />
      </nav>
      <BookingPanel
        id={search.resa ?? null}
        onClose={() => void navigate({ to: ".", search: (s: object) => ({ ...s, resa: undefined }) })}
      />
    </SaleProvider>
  );
}

/** Ouvre la fiche d'une réservation sans quitter l'écran courant. */
export function useOpenBooking(): (id: number) => void {
  const navigate = useNavigate();
  return (id: number) => void navigate({ to: ".", search: (s: object) => ({ ...s, resa: id }) });
}
