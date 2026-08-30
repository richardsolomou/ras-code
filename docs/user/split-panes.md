# Working in two threads at once

On web and desktop you can put a second thread beside the one you have open, so you can read one agent's progress while you drive another.

## Open a second thread

Drag a thread from the sidebar onto the chat area. The left and right halves light up as you drag; drop on the half you want the thread to occupy.

Once a split is open, drop another thread on either pane to change that pane. Dropping a thread that is already visible moves its pane to the side where you dropped it.

You can also right-click a thread in the sidebar and choose **Open in split**. It opens on the right. The option is hidden for the thread you already have open, and when the window is too narrow to hold two panes.

## Navigate between threads

Clicking a thread in the sidebar opens it in the active pane and leaves the other pane alone. If the thread is already visible, clicking it activates that pane instead.

Choose **Close split pane** to return to one thread.

## Which pane you are working in

Click a pane to work in it. A thin accent line marks the active pane, its thread is highlighted in the sidebar, and thread shortcuts follow the real keyboard focus. Each pane remembers its last focused control and restores it when it is still available, otherwise it returns to the composer.

Each pane keeps its own terminal, diff, browser, and file surfaces, its own composer draft, and its own model selection. Nothing is shared between them.

The address bar does not determine which pane receives shortcuts. RAS Code manages that routing detail in the background; there is no primary pane to choose.

## Resize, and close

Drag the divider between the panes to change the split. Double-click it to go back to even halves, or focus it and use the left and right arrow keys. Neither pane shrinks below a readable width.

Choose **Close split pane** in the second pane's header to go back to one thread. The divider position is remembered for the next time you split.

## Narrow windows

Two panes need room. When the window is too narrow, RAS Code shows the thread in the address bar and holds the other one aside; widen the window, or collapse the sidebar, and it comes straight back.

Split panes are a web and desktop feature. The mobile app shows one thread at a time.
