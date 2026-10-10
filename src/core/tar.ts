// Archive .tar (ustar) minimale, sans dépendance : la sauvegarde des photos
// (lot 3, GET /api/admin/export-uploads.tar). Fichiers plats seulement, noms
// courts (< 100 octets), droits 0600, date fixe par fichier fournie.

const BLOCK = 512;

function octal(n: number, width: number): string {
  // width octets dont le zéro final.
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mtime: number): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  if (nameBytes.length === 0 || nameBytes.length >= 100) throw new Error(`nom refusé dans l'archive : ${name}`);
  const h = new Uint8Array(BLOCK);
  const put = (off: number, s: string) => h.set(enc.encode(s), off);
  h.set(nameBytes, 0);
  put(100, octal(0o600, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(Math.max(0, Math.floor(mtime)), 12));
  put(148, "        "); // somme de contrôle : des espaces pendant le calcul
  h[156] = 0x30; // « 0 » : fichier ordinaire
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
  /** Secondes depuis l'époque Unix. */
  mtime?: number;
}

/** Un membre de l'archive : en-tête + contenu complété au bloc. */
export function tarEntry(e: TarEntry): Uint8Array {
  const out = new Uint8Array(BLOCK + Math.ceil(e.bytes.length / BLOCK) * BLOCK);
  out.set(header(e.name, e.bytes.length, e.mtime ?? 0), 0);
  out.set(e.bytes, BLOCK);
  return out;
}

/** Fin d'archive : deux blocs nuls. */
export const TAR_END = new Uint8Array(2 * BLOCK);

/** Concatène les fichiers en une archive tar complète (deux blocs nuls de fin). */
export function buildTar(entries: TarEntry[]): Uint8Array {
  const parts = entries.map(tarEntry);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + TAR_END.length);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** L'archive en flux : un fichier lu à la fois, jamais toute la photothèque en
 *  mémoire (contrôle Codex). `read` est appelé au moment où le client tire. */
export function tarStream(names: string[], read: (name: string) => Promise<{ bytes: Uint8Array; mtime: number }>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < names.length) {
        const name = names[i++]!;
        const { bytes, mtime } = await read(name);
        controller.enqueue(tarEntry({ name, bytes, mtime }));
      } else {
        controller.enqueue(TAR_END);
        controller.close();
      }
    },
  });
}
