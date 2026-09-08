# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari is also available. Safari protects its cookies with Full Disk Access rather than
a keychain, so the import wizard asks you to grant it: **Open System Settings** takes you to the
right pane, and macOS may ask you to quit and reopen T3 Code before the grant applies. You can
revoke Full Disk Access after the import is done. Only Safari's primary profile is imported; cookies
kept by additional Safari profiles are not.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Existing browser sessions and saved logins

Your existing browser cookies and saved logins remain available after upgrading. Named sessions and
new browser profiles keep separate logins, even when their names match. A temporary legacy session
can still use your saved shared login to sign in.

Clearing cookies or cache from a tab affects that tab's profile. Removing a browser profile also
removes the passwords saved for that profile; saved logins in other profiles remain available.

## Browser preview sizes

A pane's mini preview can open as a larger floating window over the pane grid. Choose **Open floating
window**, then drag its title bar or resize it from the bottom-right grip. The uncovered panes stay
interactive, so you can keep chatting with the thread that controls the browser.

The floating window has a **Full screen** button. Leaving full screen restores the window's previous
size and position. **Return to mini preview** restores the small pane preview without closing the
browser. Each thread remembers its mini-preview and floating-window dimensions separately.

Opening the floating window initially makes the page fill its available space. The viewport controls
can instead simulate a particular screen size or a mobile device. Use **Fill available space** to
return to a page that resizes with the window.
