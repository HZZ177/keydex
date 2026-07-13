export type KeydexBaselineSurface = "chrome-vite" | "tauri-webview2";
export type KeydexBaselineSigningTarget = "chrome-trend" | "desktop-product";

export interface KeydexBaselineValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateKeydexBaselineReport(report: unknown): KeydexBaselineValidation {
  const errors: string[] = [];
  if (!isRecord(report)) {
    return { valid: false, errors: ["report must be an object"] };
  }
  if (report.schemaVersion !== "keydex-markdown-baseline/v1") {
    errors.push("unexpected schemaVersion");
  }
  const surface = report.surface;
  if (surface !== "chrome-vite" && surface !== "tauri-webview2") {
    errors.push("surface must be chrome-vite or tauri-webview2");
  }
  const expectedScope = surface === "chrome-vite" ? "trend-only" : "product-baseline";
  if (report.signingScope !== expectedScope) {
    errors.push(`${String(surface)} must use signingScope=${expectedScope}`);
  }
  if (!Number.isSafeInteger(report.sampleCount) || Number(report.sampleCount) < 3) {
    errors.push("sampleCount must be at least 3");
  }
  if (!Number.isSafeInteger(report.frameCount) || Number(report.frameCount) < 120) {
    errors.push("frameCount must be at least 120");
  }
  validateEnvironment(report.environment, surface, errors);
  if (!isRecord(report.readFailure) || (!isNonEmptyString(report.readFailure.message) && !isNonEmptyString(report.readFailure.error))) {
    errors.push("readFailure must preserve a message or error");
  }
  if (!Array.isArray(report.cases) || report.cases.length < 1) {
    errors.push("cases must be a non-empty array");
  } else {
    for (const [index, baselineCase] of report.cases.entries()) {
      validateCase(baselineCase, index, errors);
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertKeydexBaselineCanSign(
  report: unknown,
  target: KeydexBaselineSigningTarget,
): void {
  const validation = validateKeydexBaselineReport(report);
  if (!validation.valid) {
    throw new Error(`Invalid Keydex baseline: ${validation.errors.join("; ")}`);
  }
  const surface = (report as { surface: KeydexBaselineSurface }).surface;
  const permitted = target === "chrome-trend" ? surface === "chrome-vite" : surface === "tauri-webview2";
  if (!permitted) {
    throw new Error(`${surface} cannot sign ${target}`);
  }
}

function validateEnvironment(environment: unknown, surface: unknown, errors: string[]): void {
  if (!isRecord(environment)) {
    errors.push("environment is required");
    return;
  }
  for (const key of ["os", "cpu", "productRevision", "pythonRuntime", "pythonSidecar"] as const) {
    if (!isNonEmptyString(environment[key])) {
      errors.push(`environment.${key} is required`);
    }
  }
  if (!Number.isFinite(environment.memoryBytes) || Number(environment.memoryBytes) <= 0) {
    errors.push("environment.memoryBytes must be positive");
  }
  if (!isRecord(environment.browser) || !isNonEmptyString(environment.browser.userAgent)) {
    errors.push("environment.browser.userAgent is required");
  }
  if (surface === "tauri-webview2" && !/Edg\//u.test(String((environment.browser as Record<string, unknown>)?.userAgent ?? ""))) {
    errors.push("desktop product baseline must identify the WebView2/Edge runtime");
  }
}

function validateCase(value: unknown, index: number, errors: string[]): void {
  if (!isRecord(value) || !isRecord(value.fixture) || !isNonEmptyString(value.fixture.id) || !isNonEmptyString(value.fixture.hash)) {
    errors.push(`cases[${index}] requires fixture id and hash`);
    return;
  }
  if (value.status === "failed") {
    if (!isNonEmptyString(value.error)) {
      errors.push(`cases[${index}] failed without an error`);
    }
    return;
  }
  if (value.status !== "passed") {
    errors.push(`cases[${index}] has invalid status`);
    return;
  }
  for (const cacheMode of ["cold", "warm"] as const) {
    const group = value[cacheMode];
    if (!isRecord(group)) {
      errors.push(`cases[${index}].${cacheMode} is required`);
      continue;
    }
    for (const metric of ["open", "reveal", "scroll"] as const) {
      const summary = group[metric];
      if (!isRecord(summary) || !Array.isArray(summary.raw) || summary.raw.length < 3) {
        errors.push(`cases[${index}].${cacheMode}.${metric} requires raw samples`);
        continue;
      }
      for (const percentile of ["p50", "p95", "p99"] as const) {
        if (!Number.isFinite(summary[percentile])) {
          errors.push(`cases[${index}].${cacheMode}.${metric}.${percentile} is required`);
        }
      }
    }
    if (!isRecord(group.diagnostics) || !Number.isFinite(group.diagnostics.documentNodeCount)) {
      errors.push(`cases[${index}].${cacheMode}.diagnostics DOM sample is required`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

