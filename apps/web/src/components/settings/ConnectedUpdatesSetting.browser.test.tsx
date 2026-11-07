import "~/index.css";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { ConnectedUpdatesSetting } from "./ConnectedUpdatesSetting";

it("loads the desktop preference and lets the owner disable and re-enable controller updates", async () => {
  let saved = true;
  const bridge = {
    connectedUpdates: async (enabled?: boolean) => {
      if (enabled !== undefined) saved = enabled;
      return saved;
    },
  };
  // This preference belongs to Electron and needs no environment router.
  await using screen = await render(<ConnectedUpdatesSetting bridge={bridge} />, { router: false });
  const toggle = screen.getByRole("switch");
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  expect(saved).toBe(false);
  await toggle.click();
  await expect.element(toggle).toBeChecked();
  expect(saved).toBe(true);
});
