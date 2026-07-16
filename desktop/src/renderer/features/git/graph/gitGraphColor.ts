/**
 * Git graph color generation adapted from IntelliJ Platform's
 * DefaultColorGenerator.
 *
 * Source: JetBrains/intellij-community
 * platform/vcs-log/impl/src/com/intellij/vcs/log/graph/DefaultColorGenerator.kt
 * License: Apache-2.0, Copyright JetBrains s.r.o. and contributors.
 *
 * JetBrains derives a hue from a stable integer color id, then normalizes all
 * graph colors to the same saturation and brightness. Keydex keeps that color
 * system while ordering the ids so neighboring lanes remain easy to tell apart.
 */

export const GIT_GRAPH_COLOR_COUNT = 10;

const JETBRAINS_GRAPH_SATURATION = 0.4;
const JETBRAINS_GRAPH_BRIGHTNESS = 0.65;
const LANE_COLOR_IDS = [7, 5, 3, 8, 6, 4, 9, 2, 0, 1] as const;

export function gitGraphColor(laneColorIndex: number): string {
  const normalizedIndex = ((laneColorIndex % GIT_GRAPH_COLOR_COUNT) + GIT_GRAPH_COLOR_COUNT) % GIT_GRAPH_COLOR_COUNT;
  return jetBrainsGraphColor(LANE_COLOR_IDS[normalizedIndex]);
}

export function jetBrainsGraphColor(colorId: number): string {
  const red = rangeFix(colorId * 200 + 30) / 255;
  const green = rangeFix(colorId * 130 + 50) / 255;
  const blue = rangeFix(colorId * 90 + 100) / 255;
  return hsvToHex(rgbHue(red, green, blue), JETBRAINS_GRAPH_SATURATION, JETBRAINS_GRAPH_BRIGHTNESS);
}

function rangeFix(value: number): number {
  return Math.abs(value % 100) + 70;
}

function rgbHue(red: number, green: number, blue: number): number {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta === 0) return 0;

  let sector: number;
  if (maximum === red) sector = ((green - blue) / delta) % 6;
  else if (maximum === green) sector = ((blue - red) / delta) + 2;
  else sector = ((red - green) / delta) + 4;
  return ((sector / 6) + 1) % 1;
}

function hsvToHex(hue: number, saturation: number, brightness: number): string {
  const sector = hue * 6;
  const sectorIndex = Math.floor(sector);
  const fraction = sector - sectorIndex;
  const low = brightness * (1 - saturation);
  const falling = brightness * (1 - saturation * fraction);
  const rising = brightness * (1 - saturation * (1 - fraction));
  const channels = [
    [brightness, rising, low],
    [falling, brightness, low],
    [low, brightness, rising],
    [low, falling, brightness],
    [rising, low, brightness],
    [brightness, low, falling],
  ][sectorIndex % 6];
  return `#${channels.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}
