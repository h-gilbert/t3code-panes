# Browser

Browser pages open in an inset over the thread. Use its header to switch tabs,
expand to full screen, or open a floating window. Browser pages never open in the sidebar. Existing sidebar tabs are kept
when you switch to the browser.

## Editing

In the desktop app's browser, click a text field and use **Command-V** on macOS
or **Ctrl-V** on Windows and Linux to paste. This works in the inset browser
and the floating browser.

Right-click inside the page for **Undo**, **Redo**, **Cut**, **Copy**, **Paste**,
and **Select All**. Unavailable actions are disabled according to the field and
selection, including restrictions on copying password fields.

## Uploads and downloads

Ask your agent to upload a file from its machine to a page in the desktop
browser, or to download a file from that page. The agent handles the transfer
without opening an Open or Save dialog, including when it runs on a remote
machine. Uploads support files up to 1 GiB each, with up to 10 files per upload.
Downloads can be up to 50 MiB each.

Your own uploads and downloads still use the usual dialogs. Using the tab
returns control to you. Uploads work with standard file inputs; pages using
the File System Access API picker are not supported yet.

## Share a desktop's browser

On the desktop that holds your logins, connect to the remote environment, then
select that environment in **Settings → Integrations → Browser host** and choose
this desktop. Agents in that environment use the desktop's browser profiles,
including their existing logins. Keep the desktop app open and connected; it can
be minimized or hidden, but the computer must stay awake.
Close existing tabs before changing hosts. If the selected host disconnects,
browser operations fail until it reconnects; they do not switch to another profile.

## Route browser traffic through a proxy

Set **Settings → Integrations → Browser proxy** on the host desktop to a proxy
URL, such as `socks5://127.0.0.1:1080`. Open a new tab to apply it to browser
sessions. Other apps and T3's server connections keep their normal routes.
An unavailable proxy makes pages fail instead of falling back to a direct
connection. Clear the setting and open a new tab to restore system networking.

The proxy also handles localhost addresses. Through a remote SOCKS proxy,
`localhost` refers to the proxy machine. To open a development server on your
Mac, use its reachable network address instead.
