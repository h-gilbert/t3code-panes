import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SecretRequestCard } from "./SecretRequestCard";

const state = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { answerSecretRequest: {} } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));

it("keeps a login private, defaults reuse to the project, and clears fields after saving", async () => {
  state.answer.mockReset().mockResolvedValue({ _tag: "Success" });
  const item = {
    id: TurnItemId.make("private-card"),
    threadId: ThreadId.make("thread"),
    type: "secret_request" as const,
    label: "Example account",
    reason: "Save this login for later",
    credential: { name: "Example", kind: "login" as const, website: "https://example.com" },
    secretStatus: "pending" as const,
  };
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("environment")}
      item={item as never}
      visibility="local"
    />,
  );
  const username = screen.getByLabelText("Username or email");
  const password = screen.getByPlaceholder("Password");
  const save = screen.getByRole("button", { name: "Save securely" });
  await expect.element(save).toBeDisabled();
  await userEvent.type(username, "user@example.com");
  await userEvent.type(password, " password with spaces ");
  await expect.element(password).toHaveAttribute("type", "password");
  expect(screen.container.textContent).not.toContain("password with spaces");
  await userEvent.click(save);
  expect(state.answer.mock.calls[0]![0].input.answer).toEqual({
    type: "save",
    username: "user@example.com",
    secret: " password with spaces ",
    scope: "project",
  });
  await expect.element(password).toHaveValue("");
  await expect.element(username).toHaveValue("");
  await userEvent.type(username, "user@example.com");
  await userEvent.type(password, "another-password");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(save);
  expect(state.answer.mock.calls[1]![0].input.answer.scope).toBe("environment");
});
