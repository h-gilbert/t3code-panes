# Pane workspaces

Pane workspaces are the desktop app's default view. They let you watch and interact with several
threads and projects at once. Each app window keeps its own workspace configuration.

The thread sidebar starts collapsed so the panes receive the full window. Use the sidebar button
in the top-left corner or the configured sidebar shortcut to open it when choosing a thread.

The project name in each pane header is the project menu. A project represents a directory (or a
logical group of the same repository across environments). The generated thread title appears next
to the project name and updates everywhere when the thread is renamed or its title is regenerated.
Hover a project in the menu and click its X (or press Delete) to hide it from the menu on this
device. The project and its threads are kept. Choose it again from **Hidden projects**, or add its
directory again, to bring it back. An empty pane lists your projects next to the selected project's
threads. Click a project to start a new thread in it.
The sidebar shows threads from every project assigned to a visible pane. Focusing a pane chooses
where the next thread opens, and the project picker in the sidebar changes that pane's project. Use
the pane header to maximize it temporarily. The X removes the thread from that pane without stopping
its work, including work running on another environment. The checkmark
settles an idle thread and clears the pane. It stays disabled while the thread is working or waiting
for you. Settlement stops the thread's provider session, background work, and managed terminal
processes without deleting its history. Settled threads remain available from the sidebar and
`/resume`; continuing the thread starts resources again as needed.

Drag a pane header onto another pane to swap them. In the grid layout, a pane count that would
leave an empty cell (3, 5, or 7) makes the first pane tall instead. Drag a thread into the first
pane to give it the extra space.

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
**Option-Command-9** to set the pane count, **Option-Command-G** for grid,
**Option-Command-C** for columns, and **Option-Command-R** for rows. Use
**Shift-Option-Command-R** to reset the workspace and **Option-Command-N** to open another
independent workspace window. The existing **Command-B** shortcut shows or hides the sidebar. On
non-macOS platforms, use Alt and Control in place of Option and Command. All shortcuts can be
changed in Settings.

On macOS, each workspace window has a numbered session title in the Window menu and the Dock menu.
Choose one of those titles to bring that workspace to the front.

An empty pane lists open threads that are not already assigned elsewhere in the workspace. Select
a project in the pane header to limit the list to that project, or clear the project to see threads
from every project. Choose a thread to resume it in the pane, or use **New thread** when a project
is selected.

When you quit and reopen the desktop app, T3 Code restores every workspace window with the same
pane assignments, size, position, and maximized state. Closing one window removes it from the next
session without stopping the threads shown in its panes.

On macOS desktop, the titlebar strip remains available for the traffic lights, window dragging,
and workspace controls. It disappears in fullscreen so the panes use the entire window; the same
actions remain available through their shortcuts.

Agent browser work stays in the background by default. Agents can show a page when you ask
to see it or need to interact, such as signing in. You can enable automatic preview display in
Settings with **Auto-show floating preview**. Existing saved preferences are preserved.

When shown, the shared browser starts as a fixed 320 × 200 preview in its pane's
top-right corner. It cannot be dragged or resized. Its single toolbar offers a floating window
above the panes, fullscreen, and close. The page scales to fit the preview, without a separate
viewport toolbar or resize footer.

The page fills the floating and fullscreen views, without letterboxing.
The floating window can be dragged across the pane grid and resized at its bottom-right
edge, without a footer below the page. Its toolbar can return it to the small preview. Fullscreen restores the previous mode.
Moving or resizing the floating window does not select another pane. Agents can also close
the browser themselves when they finish with it.

When connected to a remote environment, localhost browser URLs target that environment. Local
environments keep localhost navigation on this computer. Remote preview ports require a supported
private-network connection; unsupported public relay routes report an error.

In the docked browser, when a tab uses an exact viewport size, a Viewport row appears above the page. Enter width and
height directly, lock the current ratio, choose a phone or tablet preset, or use Mobile for a quick
phone-sized check. Fill returns the page to the available browser space. Only the X in the browser
header closes the browser.

The shared browser keeps cookies and logins between sessions, so signing in to a site once keeps
it available for later agent work. An agent can also open a tab under a named profile — a separate
persistent cookie space — or as an ephemeral session that starts with no stored data and is
discarded when the app quits.

You can save a site login from the browser's menu ("Save login for this site…"). Logins are
encrypted with the operating system's keychain and never leave this computer. Each login is bound
to its T3 Code environment, browser profile, and exact HTTPS site. HTTP is allowed only for local
development sites. You or an agent can then fill the site's sign-in form automatically. Reopen
**Save login for this site…** to update or remove a saved login.

Saved-login autofill and agent-provided page scripts cannot run in the same page document. If the
agent has evaluated JavaScript, navigate or reload before filling a saved login. After a password
is filled, the agent can continue with normal browser controls, but it cannot evaluate JavaScript
until the page fully navigates. This keeps the password out of the agent's tool results. The site
itself still receives the password, so only save accounts you are comfortable delegating.

Workspace assignments and layouts are stored locally in the browser or desktop app. Clearing local
storage resets them.
