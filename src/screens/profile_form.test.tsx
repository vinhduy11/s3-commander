// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileForm } from "./profile_form";
import { listAwsProfiles, readAwsProfile } from "../profile/aws_import_api";

vi.mock("../profile/aws_import_api", () => ({ listAwsProfiles: vi.fn(), readAwsProfile: vi.fn() }));

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
const select = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
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
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("Transfer settings section", () => {
  const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-controls=transfer-settings]")!;
  const open = () => act(() => toggle().click());
  const choose = (label: string, value: string) =>
    act(() => {
      const el = select(label);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("is collapsed by default and opens on click", () => {
    render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("input[aria-label=\"Multipart threshold\"]")).toBeNull();
    open();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(input("Multipart threshold")).not.toBeNull();
  });

  it("shows the defaults as placeholders", () => {
    render();
    open();
    expect(input("Multipart threshold").placeholder).toBe("8MB");
    expect(input("Multipart chunk size").placeholder).toBe("8MB");
    expect(input("Max concurrent requests").placeholder).toBe("10");
    expect(select("Addressing style").options[0].textContent).toMatch(/default.*path/i);
  });

  it("shows inline per-field errors and blocks Save", () => {
    render();
    fillValid();
    open();
    type("Multipart chunk size", "1MB");
    blur("Multipart chunk size");
    type("Max concurrent requests", "0");
    blur("Max concurrent requests");
    expect(errorOf("Multipart chunk size")).toMatch(/5 MB|5 MiB/);
    expect(errorOf("Max concurrent requests")).toMatch(/1 and 256/);
    expect(errorOf("Multipart threshold")).toBe("");
    expect(save().disabled).toBe(true);
  });

  it("flags threshold smaller than chunk size", () => {
    render();
    open();
    type("Multipart threshold", "6MB");
    type("Multipart chunk size", "7MB");
    blur("Multipart threshold");
    expect(errorOf("Multipart threshold")).toMatch(/chunk size/i);
  });

  it("opens itself when a server error belongs to one of its fields", () => {
    render({ serverErrors: { max_concurrent_requests: "Server says no." } });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(errorOf("Max concurrent requests")).toBe("Server says no.");
  });

  it("submits normalized transfer values", () => {
    const { onSubmit } = render();
    fillValid();
    open();
    type("Multipart threshold", "100 mb");
    type("Max concurrent requests", "20");
    choose("Addressing style", "virtual");
    act(() => save().click());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ multipart_threshold: "100MB", max_concurrent_requests: "20", addressing_style: "virtual" });
  });

  it("starts with the stored values and expands when any is set", () => {
    render({ initial: { ...EMPTY, id: "p1", name: "Prod", endpoint: "https://m.example.com", access_key: "ak", multipart_chunksize: "16MB" } });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(input("Multipart chunk size").value).toBe("16MB");
  });
});

describe("Import from AWS CLI", () => {
  const importButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Import from AWS CLI")!;
  const flush = () => act(async () => { await Promise.resolve(); });
  const names = () => [...host.querySelectorAll("[data-testid=aws-profile-list] button")].map((b) => b.textContent);
  const pick = (name: string) => act(async () => { [...host.querySelectorAll<HTMLButtonElement>("[data-testid=aws-profile-list] button")].find((b) => b.textContent === name)!.click(); });

  beforeEach(() => {
    vi.mocked(listAwsProfiles).mockReset();
    vi.mocked(readAwsProfile).mockReset();
  });

  it("does nothing until the button is clicked", () => {
    render();
    expect(listAwsProfiles).not.toHaveBeenCalled();
    expect(readAwsProfile).not.toHaveBeenCalled();
  });

  it("lists the profile names and fills the form as an editable preview", async () => {
    vi.mocked(listAwsProfiles).mockResolvedValue(["default", "lab"]);
    vi.mocked(readAwsProfile).mockResolvedValue({
      multipart_threshold: "64MB", multipart_chunksize: "16MB", max_concurrent_requests: "20", addressing_style: "virtual",
      region: "eu-test-1", endpoint_url: "http://lab.example:9000",
    });
    const { onSubmit } = render();
    act(() => importButton().click());
    await flush();
    expect(names()).toEqual(["default", "lab"]);
    await pick("lab");
    expect(readAwsProfile).toHaveBeenCalledWith("lab");
    expect(input("Endpoint URL").value).toBe("http://lab.example:9000");
    expect(input("Region").value).toBe("eu-test-1");
    expect(input("Multipart threshold").value).toBe("64MB");
    expect(select("Addressing style").value).toBe("virtual");
    expect(host.querySelector("[data-testid=aws-profile-list]")).toBeNull();
    // preview is editable and nothing was saved
    expect(onSubmit).not.toHaveBeenCalled();
    type("Multipart threshold", "32MB");
    expect(input("Multipart threshold").value).toBe("32MB");
  });

  it("leaves fields untouched when the profile does not define them", async () => {
    vi.mocked(listAwsProfiles).mockResolvedValue(["lab"]);
    vi.mocked(readAwsProfile).mockResolvedValue({ region: "eu-test-1" });
    render();
    type("Endpoint URL", "https://keep.example.com");
    act(() => importButton().click());
    await flush();
    await pick("lab");
    expect(input("Endpoint URL").value).toBe("https://keep.example.com");
    expect(input("Region").value).toBe("eu-test-1");
  });

  it("flags a bad imported value instead of accepting it", async () => {
    vi.mocked(listAwsProfiles).mockResolvedValue(["lab"]);
    vi.mocked(readAwsProfile).mockResolvedValue({ multipart_chunksize: "1MB", max_concurrent_requests: "many" });
    render();
    fillValid();
    act(() => importButton().click());
    await flush();
    await pick("lab");
    expect(errorOf("Multipart chunk size")).toMatch(/5 MB|5 MiB/);
    expect(errorOf("Max concurrent requests")).toMatch(/1 and 256/);
    expect(save().disabled).toBe(true);
  });

  it("shows an empty state when the file has no profiles", async () => {
    vi.mocked(listAwsProfiles).mockResolvedValue([]);
    render();
    act(() => importButton().click());
    await flush();
    expect(host.textContent).toMatch(/no profiles found/i);
  });

  it("shows the message when the file is missing", async () => {
    vi.mocked(listAwsProfiles).mockRejectedValue("AWS config file not found.");
    render();
    act(() => importButton().click());
    await flush();
    expect(host.querySelector("[data-testid=aws-import-message]")?.textContent).toBe("AWS config file not found.");
  });

  it("shows the message when the profile cannot be read", async () => {
    vi.mocked(listAwsProfiles).mockResolvedValue(["lab"]);
    vi.mocked(readAwsProfile).mockRejectedValue("Profile \"lab\" was not found in the AWS config file.");
    render();
    act(() => importButton().click());
    await flush();
    await pick("lab");
    expect(host.querySelector("[data-testid=aws-import-message]")?.textContent).toMatch(/was not found/);
  });
});

