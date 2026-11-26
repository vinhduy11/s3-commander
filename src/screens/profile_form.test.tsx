// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "./profile_form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const EMPTY = { id: "", name: "", endpoint: "", access_key: "", secret_key: "", region: "us-east-1" };
const render = (props: Partial<Parameters<typeof ProfileForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  act(() => root.render(<ProfileForm initial={EMPTY} others={["Prod"]} onSubmit={onSubmit} onCancel={onCancel} {...props} />));
  return { onSubmit, onCancel };
};
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label^="${label}"]`)!;
const save = () => host.querySelector<HTMLButtonElement>("button[type=submit]")!;
const type = (label: string, value: string) =>
  act(() => {
    const el = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const blur = (label: string) => act(() => input(label).dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const errorOf = (label: string) => {
  const id = input(label).getAttribute("aria-describedby");
  return id ? host.querySelector(`#${id}`)?.textContent ?? "" : "";
};
const fillValid = () => {
  type("Name", "Dev");
  type("Endpoint URL", "https://minio.example.com");
  type("Access key", "ak");
  type("Secret key", "sk");
};

describe("ProfileForm", () => {
  it("starts with Save disabled and no inline errors shown yet", () => {
    render();
    expect(save().disabled).toBe(true);
    expect(host.querySelectorAll("[role=alert]").length).toBe(0);
  });

  it("shows an inline error next to the field once it is touched, and disables Save", () => {
    render();
    type("Endpoint URL", "ftp://x");
    blur("Endpoint URL");
    expect(errorOf("Endpoint URL")).toMatch(/http/);
    expect(input("Endpoint URL").getAttribute("aria-invalid")).toBe("true");
    expect(save().disabled).toBe(true);
  });

  it("shows a separate error for each invalid field", () => {
    render();
    type("Name", "Prod");
    blur("Name");
    type("Access key", "a b");
    blur("Access key");
    expect(errorOf("Name")).toMatch(/already exists/);
    expect(errorOf("Access key")).toMatch(/spaces/);
    expect(errorOf("Endpoint URL")).toBe("");
  });

  it("enables Save when everything is valid and submits the normalized values", () => {
    const { onSubmit } = render();
    fillValid();
    type("Endpoint URL", " https://minio.example.com/ ");
    expect(save().disabled).toBe(false);
    act(() => save().click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: "Dev", endpoint: "https://minio.example.com", region: "us-east-1" });
  });

  it("shows the http warning without blocking Save; https shows none", () => {
    render();
    fillValid();
    type("Endpoint URL", "http://localhost:9000");
    expect(host.querySelector("[data-testid=http-warning]")?.textContent).toMatch(/unencrypted/i);
    expect(save().disabled).toBe(false);
    type("Endpoint URL", "https://minio.example.com");
    expect(host.querySelector("[data-testid=http-warning]")).toBeNull();
  });

  it("edit: empty secret is accepted and the stored one is kept", () => {
    const { onSubmit } = render({ others: [], initial: { ...EMPTY, id: "p1", name: "Prod", endpoint: "https://m.example.com", access_key: "ak" } });
    expect(save().disabled).toBe(false);
    act(() => save().click());
    expect(onSubmit.mock.calls[0][0].secret_key).toBe("");
  });

  it("create: empty secret blocks Save", () => {
    render();
    fillValid();
    type("Secret key", "");
    blur("Secret key");
    expect(save().disabled).toBe(true);
    expect(errorOf("Secret key")).toMatch(/required/);
  });

  it("shows server errors per field and clears one when that field changes", () => {
    render({ serverErrors: { endpoint: "Server says no." } });
    expect(errorOf("Endpoint URL")).toBe("Server says no.");
    expect(save().disabled).toBe(true);
    type("Endpoint URL", "https://other.example.com");
    expect(errorOf("Endpoint URL")).toBe("");
  });

  it("Cancel calls onCancel", () => {
    const { onCancel } = render();
    act(() => host.querySelector<HTMLButtonElement>("button[type=button]")!.click());
    expect(onCancel).toHaveBeenCalled();
  });
});
