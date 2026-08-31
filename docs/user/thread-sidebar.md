# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Settling releases the thread's active compute resources: T3 Code stops its provider session and
background agent work, and closes its managed terminal processes while preserving terminal history.
This has the same meaning on web, desktop, iOS, and Android because the connected server owns the
transition. You can resume or un-settle the thread later; its history remains available, and provider
or terminal resources start again only when new work needs them.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

T3 Code archives an explicitly settled thread after it has remained settled for seven days. New
activity un-settles it and cancels that pending archive. Archived threads remain available in
Settings under **Archive**, where you can restore them.
Restoring a thread returns it to the open list and starts a fresh settlement period.

`/resume` lists open threads first and settled threads second. Both groups put the most recently
active thread first, including the time when its latest agent turn finished. Archived threads do
not appear in `/resume` until you restore them.

The active list shows the newest threads up to your thread preview limit. Older threads remain
available through sidebar search. If you open an older thread from search or a link, its row stays
visible while it is open without making the list taller.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. New threads use GPT Luna to generate a concise title from the first message,
then refresh that title after later messages as the conversation's subject becomes clearer. If you
rename a thread yourself, automatic refreshes stop for that thread. The option is hidden when the
connected environment needs a server update.
