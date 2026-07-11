export interface AnnotationLaneItem {
  readonly anchorY: number;
  readonly createdAt: string;
  readonly height: number;
  readonly id: string;
}

export interface AnnotationLaneLayoutInput {
  readonly bottomPadding?: number;
  readonly cardConnectorOffset?: number;
  readonly documentHeight: number;
  readonly gap?: number;
  readonly items: readonly AnnotationLaneItem[];
  readonly reservedTop: number;
}

export interface AnnotationLanePlacement extends AnnotationLaneItem {
  readonly cardY: number;
  readonly connectorY: number;
}

export interface AnnotationLaneLayout {
  readonly documentHeight: number;
  readonly placements: readonly AnnotationLanePlacement[];
}

export function layoutAnnotationLane(
  input: AnnotationLaneLayoutInput,
): AnnotationLaneLayout {
  const gap = finiteNonNegative(input.gap ?? 12, "gap");
  const bottomPadding = finiteNonNegative(input.bottomPadding ?? 16, "bottomPadding");
  const connectorOffset = finiteNonNegative(
    input.cardConnectorOffset ?? 24,
    "cardConnectorOffset",
  );
  const requestedDocumentHeight = finiteNonNegative(input.documentHeight, "documentHeight");
  const reservedTop = finiteNonNegative(input.reservedTop, "reservedTop");
  const items = [...input.items]
    .map(validateItem)
    .sort((left, right) =>
      left.anchorY - right.anchorY
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
  if (items.length === 0) {
    return Object.freeze({
      documentHeight: requestedDocumentHeight,
      placements: Object.freeze([]),
    });
  }
  const requiredHeight = items.reduce((total, item) => total + item.height, 0)
    + gap * (items.length - 1);
  const documentHeight = Math.max(
    requestedDocumentHeight,
    reservedTop + requiredHeight + bottomPadding,
  );
  const maximumBottom = documentHeight - bottomPadding;

  const cardYs: number[] = [];
  let previousBottom = reservedTop - gap;
  for (const item of items) {
    const desiredY = item.anchorY - Math.min(connectorOffset, item.height / 2);
    const cardY = Math.max(reservedTop, desiredY, previousBottom + gap);
    cardYs.push(cardY);
    previousBottom = cardY + item.height;
  }

  const lastIndex = items.length - 1;
  if (cardYs[lastIndex] + items[lastIndex].height > maximumBottom) {
    cardYs[lastIndex] = maximumBottom - items[lastIndex].height;
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      cardYs[index] = Math.min(
        cardYs[index],
        cardYs[index + 1] - gap - items[index].height,
      );
    }
  }
  if (cardYs[0] < reservedTop) {
    throw new RangeError("Annotation lane capacity exceeded reserved document region");
  }

  return Object.freeze({
    documentHeight,
    placements: Object.freeze(items.map((item, index) => Object.freeze({
      ...item,
      cardY: cardYs[index],
      connectorY: cardYs[index] + Math.min(connectorOffset, item.height / 2),
    }))),
  });
}

function validateItem(item: AnnotationLaneItem): AnnotationLaneItem {
  const id = item.id.trim();
  if (!id) {
    throw new Error("Annotation lane item id cannot be empty");
  }
  return {
    anchorY: finiteNonNegative(item.anchorY, `anchorY:${id}`),
    createdAt: item.createdAt,
    height: positiveFinite(item.height, `height:${id}`),
    id,
  };
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}
