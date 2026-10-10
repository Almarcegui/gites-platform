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

/** Concatène les fichiers en une archive tar complète (deux blocs nuls de fin). */
export function buildTar(entries: TarEntry[]): Uint8Array {
  let total = 2 * BLOCK;
  for (const e of entries) total += BLOCK + Math.ceil(e.bytes.length / BLOCK) * BLOCK;
  const out = new Uint8Array(total);
  let off = 0;
  for (const e of entries) {
    out.set(header(e.name, e.bytes.length, e.mtime ?? 0), off);
    off += BLOCK;
    out.set(e.bytes, off);
    off += Math.ceil(e.bytes.length / BLOCK) * BLOCK;
  }
  return out;
}
