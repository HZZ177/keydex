import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { ProviderModal, validateProviderForm } from "@/renderer/pages/settings/model";

describe("ProviderModal", () => {
  it("validates required fields before saving", () => {
    const runtime = fakeRuntime();

    render(
      <ProviderModal
        mode="create"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onSaved={vi.fn()}
        runtime={runtime}
      />,
    );

    fireEvent.submit(screen.getByRole("form", { name: "新增供应商" }));

    expect(screen.getByRole("alert").textContent).toBe("请填写供应商名称");
    expect(runtime.models.createProvider).not.toHaveBeenCalled();
  });

  it("creates a provider with normalized base url", async () => {
    const saved = provider({ id: "provider-created", name: "默认模型服务" });
    const runtime = fakeRuntime({ createProvider: vi.fn().mockResolvedValue(saved) });
    const onSaved = vi.fn();

    render(
      <ProviderModal
        mode="create"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onSaved={onSaved}
        runtime={runtime}
      />,
    );

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: " 默认模型服务 " } });
    fireEvent.change(screen.getByLabelText("接口地址"), { target: { value: "https://api.example.com/v1/" } });
    fireEvent.change(screen.getByLabelText("接口密钥"), { target: { value: "sk-secret" } });
    fireEvent.submit(screen.getByRole("form", { name: "新增供应商" }));

    await waitFor(() => {
      expect(runtime.models.createProvider).toHaveBeenCalledWith({
        name: "默认模型服务",
        base_url: "https://api.example.com/v1",
        api_key: "sk-secret",
        enabled: true,
      });
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("updates provider without sending api key when the field is blank", async () => {
    const original = provider({ id: "provider-1", name: "旧名称", api_key_set: true });
    const saved = provider({ id: "provider-1", name: "新名称", enabled: false });
    const runtime = fakeRuntime({ updateProvider: vi.fn().mockResolvedValue(saved) });
    const onSaved = vi.fn();

    render(
      <ProviderModal
        mode="edit"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onSaved={onSaved}
        provider={original}
        runtime={runtime}
      />,
    );

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新名称" } });
    fireEvent.change(screen.getByLabelText("接口地址"), { target: { value: "https://api.changed/v1/" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("form", { name: "编辑供应商" }));

    await waitFor(() => {
      expect(runtime.models.updateProvider).toHaveBeenCalled();
    });
    const patch = vi.mocked(runtime.models.updateProvider).mock.calls[0][1];
    expect(patch).toEqual({
      name: "新名称",
      base_url: "https://api.changed/v1",
      enabled: false,
    });
    expect(patch).not.toHaveProperty("api_key");
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("shows backend save errors and confirms delete", async () => {
    const original = provider({ id: "provider-1" });
    const runtime = fakeRuntime({
      updateProvider: vi.fn().mockRejectedValue(new Error("供应商保存失败")),
      deleteProvider: vi.fn().mockResolvedValue(undefined),
    });
    const onDeleted = vi.fn();

    render(
      <ProviderModal
        mode="edit"
        onClose={vi.fn()}
        onDeleted={onDeleted}
        onSaved={vi.fn()}
        provider={original}
        runtime={runtime}
      />,
    );

    fireEvent.submit(screen.getByRole("form", { name: "编辑供应商" }));
    expect((await screen.findByRole("alert")).textContent).toBe("供应商保存失败");

    fireEvent.click(screen.getByRole("button", { name: "删除供应商" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(runtime.models.deleteProvider).toHaveBeenCalledWith("provider-1");
    });
    expect(onDeleted).toHaveBeenCalledWith("provider-1");
  });
});

describe("validateProviderForm", () => {
  it("rejects unsupported base url schemes", () => {
    expect(validateProviderForm("供应商", "ftp://api.example.com")).toBe("接口地址必须是 http(s) 地址");
  });
});

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "provider-1",
    name: "默认模型服务",
    base_url: "https://api.example.com/v1",
    enabled: true,
    api_key_set: false,
    api_key_preview: null,
    models: ["qwen3-coder"],
    model_enabled: {},
    health: {},
    default_model: null,
    ...overrides,
  };
}

function fakeRuntime(
  overrides: Partial<RuntimeBridge["models"]> = {},
): RuntimeBridge {
  return {
    models: {
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}
