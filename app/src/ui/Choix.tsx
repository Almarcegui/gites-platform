// Liste de choix de l'admin. Au toucher et sur écran étroit, c'est le sélecteur natif du
// téléphone (NativeSelect) : la liste déroulante de Mantine, posée dans un portail par-dessus
// un Modal plein écran, se défile mal au doigt et ne laissait pas choisir un gîte (suggestion
// n° 21, Android). À l'ordinateur, la liste Mantine habituelle.
import { NativeSelect, Select, type ComboboxData, type ComboboxProps, type MantineSize, type StyleProp, type MantineSpacing } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { CSSProperties } from "react";

export interface ChoixProps {
  label?: string;
  "aria-label"?: string;
  placeholder?: string;
  size?: MantineSize;
  data: ComboboxData;
  value: string | null;
  onChange: (value: string | null) => void;
  allowDeselect?: boolean;
  clearable?: boolean;
  w?: number | string;
  mt?: StyleProp<MantineSpacing>;
  style?: CSSProperties;
  /** Réglages de la liste Mantine (ordinateur seulement). */
  comboboxProps?: ComboboxProps;
}

/** Vrai au téléphone : pointeur grossier (doigt), ou écran étroit sur un appareil qui en a un. */
export function useChoixNatif(): boolean {
  return useMediaQuery("(pointer: coarse), (max-width: 63.99em) and (any-pointer: coarse)", false, { getInitialValueInEffect: false }) ?? false;
}

type Option = { value: string; label: string; disabled?: boolean };
const isGroup = (x: unknown): x is { group: string; items: unknown[] } => typeof x === "object" && x !== null && "group" in x;
const asOption = (x: unknown): Option => (typeof x === "string" ? { value: x, label: x } : (x as Option));

function hasValue(data: ComboboxData, v: string): boolean {
  return (data as unknown[]).some((x) => (isGroup(x) ? x.items.some((i) => asOption(i).value === v) : asOption(x).value === v));
}

export function Choix({ data, value, onChange, allowDeselect: _allowDeselect, clearable, placeholder, comboboxProps, ...rest }: ChoixProps) {
  const natif = useChoixNatif();
  if (!natif) return <Select data={data} value={value} onChange={onChange} allowDeselect={_allowDeselect} clearable={clearable} placeholder={placeholder} comboboxProps={comboboxProps} {...rest} />;
  // Une ligne vide d'abord quand rien n'est choisi (ou que l'on peut effacer), sauf si "" est déjà un vrai choix.
  const vide = (value == null || clearable) && !hasValue(data, "");
  const nativeData = vide ? [{ value: "", label: placeholder ?? "" }, ...(data as unknown[])] : (data as unknown[]);
  return (
    <NativeSelect
      {...rest}
      data={nativeData as never}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.currentTarget.value;
        onChange(vide && v === "" ? null : v);
      }}
    />
  );
}
