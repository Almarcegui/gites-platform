import { render } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";

import { App } from "../App";
import { makeRouter } from "../router";
import { makeFakeApi } from "./fakeApi";

/** Rend l'application entière, connectée, à l'adresse donnée, sur une fausse API. */
export function renderApp(path: string, extra: Parameters<typeof makeFakeApi>[0] = []) {
  localStorage.setItem("gp_session", "essai");
  localStorage.setItem("gp_user", "pilote");
  const api = makeFakeApi(extra);
  vi.stubGlobal("fetch", api.fetchMock);
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(<App router={router} queryClient={queryClient} />);
  return { ...utils, ...api, router };
}
