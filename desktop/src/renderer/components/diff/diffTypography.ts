import type { KeydexDiffProfileName } from "./profiles";

export interface KeydexDiffTypography {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly headerHeight: number;
  readonly hunkLineCount: number;
  readonly itemGap: number;
  readonly paddingInline: number;
  readonly paddingBlock: number;
  readonly minLineNumberDigits: number;
  readonly signColumnWidth: number;
  readonly tabSize: number;
}

const COMFORTABLE: KeydexDiffTypography = Object.freeze({
  fontSize: 13,
  lineHeight: 20,
  headerHeight: 36,
  hunkLineCount: 60,
  itemGap: 12,
  paddingInline: 8,
  paddingBlock: 8,
  minLineNumberDigits: 3,
  signColumnWidth: 4,
  tabSize: 2,
});

export const KEYDEX_DIFF_TYPOGRAPHY: Readonly<Record<KeydexDiffProfileName, KeydexDiffTypography>> =
  Object.freeze({
    compact: Object.freeze({
      ...COMFORTABLE,
      fontSize: 12,
      lineHeight: 18,
      headerHeight: 34,
      itemGap: 8,
      paddingInline: 6,
      paddingBlock: 6,
    }),
    review: COMFORTABLE,
    git: COMFORTABLE,
    preview: COMFORTABLE,
  });

export function keydexDiffTypography(profile: KeydexDiffProfileName) {
  return KEYDEX_DIFF_TYPOGRAPHY[profile];
}

export function keydexDiffLineNumberDigits(
  maximumLineNumber: number,
  profile: KeydexDiffProfileName,
) {
  if (!Number.isInteger(maximumLineNumber) || maximumLineNumber < 0) {
    throw new TypeError("maximumLineNumber must be a non-negative integer");
  }
  return Math.max(
    keydexDiffTypography(profile).minLineNumberDigits,
    Math.max(1, String(maximumLineNumber).length),
  );
}
