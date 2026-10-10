// Dimensions d'une image, lues dans ses premiers octets (issue #32).
//
// POURQUOI. Les galeries déclarent `width`/`height` sur chaque `<img>` — c'est
// ce qui garde le décalage de mise en page à zéro (issue #17). Quand le
// back-office rattache un fichier déjà présent dans `public/img/`, personne ne
// saisit ces deux nombres à la main : on les lit dans le fichier.
//
// Aucune dépendance : `sharp` est un outil de développement, il ne tourne
// jamais dans le Worker. Seuls les deux formats servis par le site sont gérés.

export interface ImageSize {
  width: number;
  height: number;
}

/** Dimensions d'un JPEG, lues dans son marqueur SOF. Null si l'octet-stream
 *  n'est pas un JPEG exploitable. */
export function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    // Un marqueur peut être précédé d'autant d'octets 0xFF de remplissage qu'il
    // veut (ISO/IEC 10918-1 § B.1.1.2). Sans ce saut, « FF FF C0 » fait lire
    // 0xFF comme numéro de marqueur, puis 0xC0 comme longueur de segment : on
    // enjambe l'en-tête cherché et le fichier passe pour illisible.
    while (i + 1 < bytes.length && bytes[i + 1] === 0xff) i++;
    if (i + 9 >= bytes.length) return null;
    const marker = bytes[i + 1] as number;
    // 0xC4 (tables de Huffman), 0xC8 et 0xCC ne sont PAS des en-têtes de trame
    // malgré leur numéro : les inclure donnerait des dimensions aberrantes.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = view.getUint16(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Dimensions d'un WebP (conteneur RIFF, variantes VP8 / VP8L / VP8X). */
export function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = tag(12);
  if (chunk === "VP8 ") {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const at = (o: number): number => (bytes[o] as number) | ((bytes[o + 1] as number) << 8) | ((bytes[o + 2] as number) << 16);
    return { width: at(24) + 1, height: at(27) + 1 };
  }
  return null;
}

/** Dimensions d'un PNG, lues dans le bloc IHDR (toujours le premier). */
export function pngSize(bytes: Uint8Array): ImageSize | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Type réel d'une image d'après ses premiers octets (jamais d'après le nom
 *  ou l'en-tête envoyé par le navigateur). */
export function sniffImageType(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  return null;
}

/** Dimensions d'un fichier image d'après son extension, ou null. */
export function imageSize(path: string, bytes: Uint8Array): ImageSize | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return jpegSize(bytes);
  if (lower.endsWith(".webp")) return webpSize(bytes);
  if (lower.endsWith(".png")) return pngSize(bytes);
  return null;
}
