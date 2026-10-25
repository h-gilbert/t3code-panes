import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  getRestingComposerImagePreviewCounts,
  overlayComposerIsResting,
} from "./composerFooterLayout";
import { describe, expect, it } from "vite-plus/test";

import { timelineContentOverflowsViewport } from "./chat/timelineScrollAnchoring";
import { resolveContextStripLabelsCompact } from "./BranchToolbar.logic";
import {
  resolveComposerTimelineInset,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
  shouldAnimateComposerRestingTransition,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
  shouldUseRestingComposerLayout,
  COMPOSER_MODEL_PICKER_ICON_ONLY_BREAKPOINT_PX,
  shouldUseIconOnlyComposerModelPicker,
} from "./composerFooterLayout";

describe("getRestingComposerImagePreviewCounts", () => {
  it("shows at most three thumbnails and counts the remainder", () => {
    expect(getRestingComposerImagePreviewCounts(0)).toEqual({
      visibleCount: 0,
      overflowCount: 0,
    });
    expect(getRestingComposerImagePreviewCounts(3)).toEqual({
      visibleCount: 3,
      overflowCount: 0,
    });
    expect(getRestingComposerImagePreviewCounts(7)).toEqual({
      visibleCount: 3,
      overflowCount: 4,
    });
  });
});

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false);
  });

  it("uses a higher breakpoint for wide action states", () => {
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("matches the wide footer breakpoint", () => {
    expect(
      shouldUseCompactComposerPrimaryActions(
        COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1,
        { hasWideActions: true },
      ),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("shouldUseIconOnlyComposerModelPicker", () => {
  it("collapses below the model-picker breakpoint", () => {
    expect(shouldUseIconOnlyComposerModelPicker(null)).toBe(false);
    expect(
      shouldUseIconOnlyComposerModelPicker(COMPOSER_MODEL_PICKER_ICON_ONLY_BREAKPOINT_PX - 1),
    ).toBe(true);
    expect(
      shouldUseIconOnlyComposerModelPicker(COMPOSER_MODEL_PICKER_ICON_ONLY_BREAKPOINT_PX),
    ).toBe(false);
  });
});

describe("overlayComposerIsResting", () => {
  it("drops a resting reservation once a status bar replaces the composer", () => {
    const isResting = overlayComposerIsResting({
      composerMounted: false,
      composerReportedResting: true,
    });
    expect(isResting).toBe(false);
    expect(resolveComposerTimelineInset({ currentInset: 0, overlayHeight: 56, isResting })).toBe(
      56,
    );
    expect(overlayComposerIsResting({ composerMounted: true, composerReportedResting: true })).toBe(
      true,
    );
  });
});

describe("resolveComposerTimelineInset", () => {
  it("keeps timeline padding stable when the model-only strip appears on collapse", () => {
    const expanded = resolveComposerTimelineInset({
      currentInset: 0,
      overlayHeight: 172,
      isResting: false,
    });
    const collapsed = resolveComposerTimelineInset({
      currentInset: expanded,
      overlayHeight: 110,
      isResting: true,
      restingOnlyHeight: 32,
    });
    expect(collapsed).toBe(expanded);
    expect(
      resolveComposerTimelineInset({
        currentInset: collapsed,
        overlayHeight: 172,
        isResting: false,
      }),
    ).toBe(expanded);
  });

  it("keeps the timeline reservation stable through notice expansion and collapse", () => {
    const collapsed = resolveComposerTimelineInset({
      currentInset: 0,
      overlayHeight: 172,
      isResting: false,
    });
    const expanded = resolveComposerTimelineInset({
      currentInset: collapsed,
      overlayHeight: 532,
      isResting: false,
      expandedNoticesHeight: 360,
    });
    expect(expanded).toBe(collapsed);
    const resting = resolveComposerTimelineInset({
      currentInset: expanded,
      overlayHeight: 470,
      isResting: true,
      expandedNoticesHeight: 360,
    });
    expect(resting).toBe(collapsed);
    expect(
      resolveComposerTimelineInset({
        currentInset: resting,
        overlayHeight: 110,
        isResting: true,
      }),
    ).toBe(collapsed);
  });
});

describe("shouldUseRestingComposerLayout", () => {
  const resting = {
    isExistingThread: true,
    isMobileViewport: false,
    isScrollCollapsed: true,
    hasExpandedChrome: false,
    hasMultilinePrompt: false,
    timelineOverflows: true,
  };

  it("uses the resting layout after a timeline scroll", () => {
    expect(shouldUseRestingComposerLayout(resting)).toBe(true);
  });

  it("keeps the composer expanded until the timeline is scrolled", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isScrollCollapsed: false })).toBe(false);
  });

  it("stays collapsed when the reclaimed space makes a short thread fit", () => {
    let isResting = false;
    const layouts: boolean[] = [];
    const overflows: boolean[] = [];
    for (let measurement = 0; measurement < 4; measurement++) {
      const timelineOverflows = timelineContentOverflowsViewport(
        {
          data: ["message"],
          scroll: 0,
          scrollLength: isResting ? 500 : 406,
          positionAtIndex: () => 24,
          sizeAtIndex: () => 400,
        },
        { composerInset: 0, anchorOffset: 24 },
      );
      overflows.push(timelineOverflows);
      const input = { ...resting, timelineOverflows };
      isResting = shouldUseRestingComposerLayout(input);
      layouts.push(isResting);
    }
    expect(overflows).toEqual([true, false, false, false]);
    expect(layouts).toEqual([true, true, true, true]);
  });

  it("keeps new-thread composers expanded", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isExistingThread: false })).toBe(false);
  });

  it("leaves responsive mobile on its existing collapse path", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isMobileViewport: true })).toBe(false);
  });

  it("keeps drawers and composer-owned menus expanded", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, hasExpandedChrome: true })).toBe(false);
  });

  it.each([false, true])(
    "keeps multiline drafts expanded when scroll collapsed is %s",
    (isScrollCollapsed) => {
      expect(
        shouldUseRestingComposerLayout({
          ...resting,
          hasMultilinePrompt: true,
          isScrollCollapsed,
        }),
      ).toBe(false);
    },
  );
});

describe("shouldAnimateComposerRestingTransition", () => {
  it("does not animate layout measurements that settle during initial mount", () => {
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: false,
        stateChanged: true,
        hasInterruptedAnimation: false,
      }),
    ).toBe(false);
  });

  it("animates later resting-state changes and interrupted transitions", () => {
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: true,
        stateChanged: true,
        hasInterruptedAnimation: false,
      }),
    ).toBe(true);
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: true,
        stateChanged: false,
        hasInterruptedAnimation: true,
      }),
    ).toBe(true);
  });
});

describe("resolveRestingComposerControlsLayout", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("shows everything when the host has room", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 357 })).toEqual({
      hiddenCount: 0,
      visible: true,
    });
  });

  it("moves trailing blocks into the overflow menu until the rest fits", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 356 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 241 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 240 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
  });

  it("shrinks the picker after moving every trailing block into overflow", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 176 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 133 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
  });

  it("hides the whole cluster below the picker's minimum readable width", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 132 })).toEqual({
      hiddenCount: 2,
      visible: false,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 0 })).toEqual({
      hiddenCount: 2,
      visible: false,
    });
  });

  it("uses the same thresholds while shrinking and growing", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 240 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 241 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
  });

  it("supports a single leading control without overflow blocks", () => {
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: 140,
        minimumFixedWidth: 140,
        blockWidths: [],
        overflowWidth: 0,
        hostWidth: 139,
      }),
    ).toEqual({ hiddenCount: 0, visible: false });
  });
});

describe("context strip labels and resting composer controls", () => {
  const stripWidth = 724;
  const labelWidth = 327;
  const chromeWidth = 125;
  const measurement = {
    gap: 4,
    naturalFixedWidth: 96.3828125 + 5 + 4,
    minimumFixedWidth: 52 + 5 + 4,
    blockWidths: [130.6953125, 119.671875],
    overflowWidth: 28,
  };
  const naturalWidth = resolveRestingComposerControlsNaturalWidth(measurement);

  function hostWidth(compact: boolean): number {
    return stripWidth - chromeWidth - (compact ? 0 : labelWidth);
  }

  it("keeps the labels compact when the full controls only fit beside compact labels", () => {
    const layout = resolveRestingComposerControlsLayout({
      ...measurement,
      hostWidth: hostWidth(true),
    });
    expect(layout).toEqual({ hiddenCount: 0, visible: true });

    const compact = resolveContextStripLabelsCompact({
      compact: true,
      neededWidth: chromeWidth + labelWidth + naturalWidth,
      availableWidth: stripWidth,
    });
    expect(compact).toBe(true);

    expect(
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth: hostWidth(compact) }),
    ).toEqual(layout);
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("settles when the measured picker width jitters below a pixel", () => {
    let layout = { hiddenCount: 0, visible: true };
    const settled: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: index % 2 === 0 ? 149 : 149.5,
        hostWidth: 357,
        previous: layout,
      });
      if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
    }
    expect(new Set(settled).size).toBe(1);
  });
});

describe("progressive composer controls", () => {
  const measurement = {
    gap: 4,
    naturalFixedWidth: 140,
    minimumFixedWidth: 80,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: [40, 60],
    overflowWidth: 24,
  };

  it("settles through fractional label-width changes at each threshold", () => {
    for (const hostWidth of [368, 288, 248]) {
      let previous = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
      for (let index = 0; index < 10; index += 1) {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous,
          naturalFixedWidth: 140 + (index % 2) * 0.5,
        });
        if (index > 1) expect(next).toEqual(previous);
        previous = next;
      }
    }
  });
});
