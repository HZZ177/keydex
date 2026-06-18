import { useEffect, useMemo, useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import type { ModelInfo } from "@/types/protocol";

export type ModelLoadState = "idle" | "loading" | "ready" | "error";

export interface RuntimeModelSelection {
  selectedModel: string;
  modelOptions: string[];
  modelLoadState: ModelLoadState;
  modelError: string | null;
  setSelectedModel: (model: string) => void;
}

export function useRuntimeModelSelection(
  runtime: RuntimeBridge = runtimeBridge,
  initialModel = "",
): RuntimeModelSelection {
  const [selectedModel, setSelectedModel] = useState(() => initialModel.trim());
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelLoadState, setModelLoadState] = useState<ModelLoadState>("idle");
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    const model = initialModel.trim();
    if (model) {
      setSelectedModel(model);
    }
  }, [initialModel]);

  useEffect(() => {
    let active = true;
    setModelLoadState("loading");
    setModelError(null);

    const loadModels = async () => {
      const [settingsResult, modelsResult] = await Promise.allSettled([
        runtime.settings.getSettings(),
        runtime.models.listModels(),
      ]);
      if (!active) {
        return;
      }

      let nextError: string | null = null;
      if (settingsResult.status === "fulfilled") {
        const model = settingsResult.value.model.model?.trim();
        if (model) {
          setSelectedModel((current) => current || model);
        }
      } else {
        nextError = `读取模型配置失败：${errorMessage(settingsResult.reason)}`;
      }

      if (modelsResult.status === "fulfilled") {
        setAvailableModels(modelsResult.value.models);
      } else {
        nextError = `读取模型列表失败：${errorMessage(modelsResult.reason)}`;
      }

      setModelError(nextError);
      setModelLoadState(nextError ? "error" : "ready");
    };

    void loadModels();
    return () => {
      active = false;
    };
  }, [runtime]);

  const modelOptions = useMemo(
    () => buildModelOptions(availableModels, selectedModel),
    [availableModels, selectedModel],
  );

  return {
    selectedModel,
    modelOptions,
    modelLoadState,
    modelError,
    setSelectedModel,
  };
}

function buildModelOptions(models: ModelInfo[], selectedModel: string): string[] {
  const ids = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (id) {
      ids.add(id);
    }
  }
  const selected = selectedModel.trim();
  if (selected) {
    ids.add(selected);
  }
  return [...ids];
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "模型读取失败";
}
