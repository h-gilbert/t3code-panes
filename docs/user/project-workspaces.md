# Pane workspaces

Pane workspaces are the desktop app's default view. They let you watch and interact with several
threads and projects at once. Each app window keeps its own workspace configuration.

The thread sidebar starts collapsed so the panes receive the full window. Use the sidebar button
in the top-left corner or the configured sidebar shortcut to open it when choosing a thread.

The project name in each pane header is the project menu. A project represents a directory (or a
logical group of the same repository across environments). The generated thread title appears next
to the project name and updates everywhere when the thread is renamed or its title is regenerated.
Focusing a pane filters the sidebar to that project; choosing a thread in the sidebar assigns it to
the focused pane. Use the pane header to maximize it temporarily or clear its assigned thread.

When the selected project has matching checkouts on more than one connected environment, use the
computer menu to the left of the model selector to choose where a new thread runs. The choice is
available until work begins; an active thread stays attached to the environment that owns its files,
terminals, Git state, and provider session.

For a Git project that is not on the selected environment yet, the same menu can prepare it. T3 Code
clones the configured remote below that environment's **Add project starts in** directory, registers
the checkout, and starts the draft in a new worktree based on the remote branch. Automatic checkout
paths include the repository owner to avoid collisions. Set that directory before the first remote
checkout; T3 Code does not guess a location on the other computer. Commit and push local work before
switching: files that exist only in another machine's working tree are not transferred.

If the destination already contains a checkout with the same `origin`, T3 Code refreshes and reuses
it. A non-empty directory with a different origin is left untouched.

Workspace layout controls are available in the macOS desktop titlebar when the app is windowed.
They are also available from the keyboard: use **Option-Command-1** through
**Option-Command-8** to set the pane count, **Option-Command-G** for grid,
**Option-Command-C** for columns, and **Option-Command-R** for rows. Use
**Shift-Option-Command-R** to reset the workspace and **Option-Command-N** to open another
independent workspace window. The existing **Command-B** shortcut shows or hides the sidebar. On
non-macOS platforms, use Alt and Control in place of Option and Command. All shortcuts can be
changed in Settings.

On macOS desktop, the titlebar strip remains available for the traffic lights, window dragging,
and workspace controls. It disappears in fullscreen so the panes use the entire window; the same
actions remain available through their shortcuts.

Workspace assignments and layouts are stored locally in the browser or desktop app. Clearing local
storage resets them.
