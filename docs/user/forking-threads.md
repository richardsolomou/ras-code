# Forking threads

Forking takes a conversation from a point in its past and continues it somewhere
else, leaving the original untouched. Use it when you want to try a different
approach without losing the one you have, or to continue with a different model.

## Forking from a response

Hover a completed agent response and open the three-dot menu to the right of
Copy. It offers two things:

- **Fork from here** — starts a new thread after that response, in its own
  worktree.
- **Revert to here** — after confirmation, restores that response's checkpoint
  and discards everything later in the thread.

Fork opens the normal thread view with the inherited conversation above an empty
composer. Continue the conversation, change the model if you want to, and send.
Nothing is created on the server until you do, so an abandoned fork remains a
draft you can discard.

The command palette also offers **Fork thread from latest response**.

## How the workspace is forked

**Fork from here** gets its own worktree, cut from the original's branch with
the files restored to exactly how they looked at the fork point. Both threads
can run at the same time without stepping on each other.

If the original thread runs in your project checkout rather than a worktree,
"fork from here" promotes the fork to a worktree so the two can still run
independently.

## What the fork remembers

The conversation up to the fork point comes across as history, shown dimmed. It
belongs to the original thread, so it stays put no matter what you revert in the
fork.

How much the _agent_ remembers depends on the provider:

- Forking a Claude thread onto the same Claude connection is a real branch of
  the underlying session. The agent keeps the full conversation, and the
  original session is untouched.
- Every other fork — a different provider, a different connection, or a provider
  with no branching of its own — starts a fresh session. The workspace is still
  restored to the fork point, and the fork's first message carries a transcript
  of the conversation so far, but this is a summary handoff rather than a true
  continuation.

Attachments are not copied into a fork; they stay with the original thread.

## Finding your way back

A forked thread shows **Forked from _thread_** in its header; click it to jump
to the original. The original shows a fork count next to its title, listing
every fork made from it. Forks are ordinary threads otherwise — rename, snooze,
archive, and delete them like any other.

## On mobile

The mobile app shows forks and their inherited history, but forks are created
from the web and desktop apps.
