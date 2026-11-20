import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import * as query from "../../state/query";

vi.mock(import("../../state/query"), { spy: true });

it.each([
  { interaction: "hover", pullRequest: false },
  { interaction: "delayed hover", pullRequest: false },
  { interaction: "focus", pullRequest: false },
  { interaction: "hover then focus", pullRequest: false },
  { interaction: "outside timeline", pullRequest: false },
  { interaction: "wheel without scroll", pullRequest: false },
  { interaction: "hover", pullRequest: true },
  { interaction: "delayed hover", pullRequest: true },
  { interaction: "focus", pullRequest: true },
  { interaction: "hover then focus", pullRequest: true },
] as const)(
  "dismisses timeline tooltips on scroll according to $interaction, PR: $pullRequest",
  async ({ interaction, pullRequest }) => {
    using _query = vi.spyOn(query, "useEnvironmentQuery").mockReturnValue({
      data: null,
      dataUpdatedAt: 0,
      error: "Pull request not found",
      failure: null,
      isPending: false,
      isSuccess: false,
      refresh: vi.fn(),
    });
    const onMouseEnter = vi.fn();
    const label = "Message link";
    const description = "https://example.com";
    const tooltip = pullRequest ? (
      <PullRequestLinkPreview
        link={<button onMouseEnter={onMouseEnter}>{label}</button>}
        originalUrl={description}
        target={{
          environmentId: EnvironmentId.make("environment-local"),
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "pingdotgg/t3code",
            number: 1,
          },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50} onMouseEnter={onMouseEnter}>
          {label}
        </TooltipTrigger>
        <TooltipPopup>{description}</TooltipPopup>
      </Tooltip>
    );
    const outside = interaction === "outside timeline";
    await using screen = await render(
      <>
        <TooltipScrollDismissArea data-testid="timeline">
          {outside ? null : tooltip}
        </TooltipScrollDismissArea>
        {outside ? tooltip : null}
      </>,
    );
    const trigger = screen.getByRole("button", { name: label }).element() as HTMLButtonElement;
    const scroller = screen.getByTestId("timeline").element();
    const popupText = () =>
      document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null;
    using _timers = fakeTimers();

    await act(async () => {
      if (interaction !== "focus") {
        trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent("mouseenter"));
        trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      }
      if (interaction === "focus" || interaction === "hover then focus") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        trigger.focus();
      }
      if (interaction !== "delayed hover") await vi.advanceTimersByTimeAsync(400);
    });
    expect(onMouseEnter).toHaveBeenCalledTimes(interaction === "focus" ? 0 : 1);
    expect(popupText()).toBe(interaction === "delayed hover" ? null : description);

    await act(async () => {
      scroller.dispatchEvent(
        interaction === "wheel without scroll"
          ? new WheelEvent("wheel", { bubbles: true, deltaY: 100 })
          : new Event("scroll"),
      );
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(popupText()).toBe(
      interaction === "hover" || interaction === "delayed hover" ? null : description,
    );
    if (interaction === "focus" || interaction === "hover then focus") {
      expect(document.activeElement).toBe(trigger);
    }
  },
);
