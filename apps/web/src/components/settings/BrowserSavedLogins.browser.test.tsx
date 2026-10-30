import type {
  DesktopBrowserCredentialSaveInput,
  DesktopBrowserCredentialSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { BrowserSavedLoginsManager } from "./BrowserSavedLogins";

const environments = [
  { environmentId: "mac", label: "Mac" },
  { environmentId: "fred", label: "Fred" },
];
const profiles = [{ id: "default", name: "Default", kind: "persistent" }] as const;

it("clears successful passwords, retains failed rows for retry and hides raw errors", async () => {
  const store = {
    list: async () => [],
    save: vi.fn(
      async (
        input: DesktopBrowserCredentialSaveInput,
      ): Promise<DesktopBrowserCredentialSummary> => {
        if (input.url.includes("fail.example")) throw new Error(input.password);
        const { password: _password, url, ...rest } = input;
        return { ...rest, id: url, origin: new URL(url).origin, updatedAt: "2026-10-31T00:00:00Z" };
      },
    ),
    delete: async () => {},
  };
  await using screen = await render(
    <BrowserSavedLoginsManager
      store={store}
      environments={environments}
      profiles={profiles}
      initialEnvironmentId="mac"
    />,
  );
  await expect.element(screen.getByRole("heading", { name: "Saved logins (0)" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Add login", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Add login", exact: true }));
  for (const [index, host, password] of [
    [1, "good.example", "first-test-secret"],
    [2, "fail.example", "second-test-secret"],
  ] as const) {
    await userEvent.type(screen.getByLabelText(`Website ${index}`), `https://${host}`);
    await userEvent.type(screen.getByLabelText(`Username ${index}`), "user@example.com");
    await userEvent.type(screen.getByLabelText(`Password ${index}`), password);
  }
  await userEvent.clear(screen.getByLabelText("Website 2"));
  await userEvent.type(screen.getByLabelText("Website 2"), "https://good.example/login");
  await userEvent.click(screen.getByRole("button", { name: "Save all logins" }));
  expect(store.save).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("Website 2"));
  await userEvent.type(screen.getByLabelText("Website 2"), "https://fail.example");
  await userEvent.click(screen.getByRole("button", { name: "Save all logins" }));
  await expect.element(screen.getByRole("heading", { name: "Saved logins (1)" })).toBeVisible();
  await expect.element(screen.getByLabelText("Password 1")).toHaveValue("second-test-secret");
  expect(screen.container.textContent).not.toContain("second-test-secret");
  expect(store.save.mock.calls[0]![0]).not.toHaveProperty("profileId");
  await userEvent.clear(screen.getByLabelText("Website 1"));
  await userEvent.type(screen.getByLabelText("Website 1"), "https://retry.example");
  await userEvent.click(screen.getByRole("button", { name: "Save all logins" }));
  await expect.element(screen.getByRole("heading", { name: "Saved logins (2)" })).toBeVisible();
  await expect.element(screen.getByLabelText("Password 1")).not.toBeInTheDocument();
});

it("replaces a password in its original scope and removes the stored login", async () => {
  const entry: DesktopBrowserCredentialSummary = {
    id: "saved",
    environmentId: "fred",
    origin: "https://example.com",
    profile: null,
    username: "saved-user",
    updatedAt: "2026-10-31T00:00:00Z",
  };
  const store = {
    list: async () => [entry],
    save: vi.fn(async (_input: DesktopBrowserCredentialSaveInput) => entry),
    delete: vi.fn(async (_id: string) => {}),
  };
  await using screen = await render(
    <BrowserSavedLoginsManager
      store={store}
      environments={environments}
      profiles={profiles}
      initialEnvironmentId="mac"
    />,
  );
  await expect.element(screen.getByRole("heading", { name: "Saved logins (1)" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Replace password" }));
  await expect.element(screen.getByLabelText("Website 1")).toBeDisabled();
  await expect.element(screen.getByLabelText("Username 1")).toBeDisabled();
  await expect.element(screen.getByLabelText("Password 1")).toHaveValue("");
  await userEvent.type(screen.getByLabelText("Password 1"), "replacement-test-secret");
  await userEvent.click(screen.getByRole("button", { name: "Save all logins" }));
  await expect.element(screen.getByLabelText("Password 1")).not.toBeInTheDocument();
  expect(store.save).toHaveBeenCalledWith({
    environmentId: "fred",
    url: "https://example.com",
    profile: null,
    username: "saved-user",
    password: "replacement-test-secret",
  });
  await userEvent.click(screen.getByRole("button", { name: "Remove", exact: true }));
  await expect.element(screen.getByRole("heading", { name: "Saved logins (0)" })).toBeVisible();
  expect(store.delete).toHaveBeenCalledWith("saved");
});
