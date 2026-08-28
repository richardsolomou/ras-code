# PostHog AI Gateway

The PostHog AI Gateway is a provider of its own. One gateway key gives you the whole gateway
catalog in one place: Anthropic's models, OpenAI's models, and open-weight models such as
`zai-org/glm-5.2` and `moonshotai/kimi-k3`.

You never choose a harness. RAS Code runs Claude Code for the gateway's `claude-*` models and Codex
for everything else, and picks the right one from the model you selected.

## Add It

In Settings, choose **Add provider**, then pick **PostHog AI Gateway**. Enter your gateway key and
add the instance.

The key is marked sensitive: RAS Code stores it as a server secret and does not send it back to the
app after saving.

The provider's Configuration tab carries three settings:

| Setting            | Default                             | What it does                             |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| Gateway base URL   | `https://ai-gateway.us.posthog.com` | Origin serving the catalog and both APIs |
| Claude binary path | `claude`                            | Harness used for `claude-*` models       |
| Codex binary path  | `codex`                             | Harness used for every other model       |

Both harnesses must be installed for the whole catalog to be available. With only one installed,
the provider stays usable for the half of the catalog that harness can serve, and its status
message names the missing one.

## Models

The provider's model list is the gateway's live catalog. RAS Code refreshes it in the background
and keeps the last good list if the gateway does not answer, so there is nothing to import by hand.

Model IDs are spelled with the publisher's own organisation name:

```text
zai-org/glm-5.2
```

The `z-ai/...` spelling does not resolve.

## Switching Models In A Thread

You can switch freely between the gateway's Claude models, and freely between its other models. You
cannot cross between the two groups in a thread that has already started: the two harnesses keep
separate conversation state, so a turn that crosses over is refused with a message asking you to
start a new thread.

## As A Fallback

This provider is a good fallback for a Claude subscription. It shares the primary Claude provider's
config directory, so a thread that has already started can move to it and keep going, as long as
the turn asks for a `claude-*` model. Fallbacks onto the gateway's other models apply to new threads
only.

Set it up on the primary provider's Configuration tab — see
[Fallback providers](./providers-claude.md#fallback-providers). **Same model** is the right choice
when the primary is a Claude provider, because the gateway serves the same model IDs.

The provider can also be a primary with a fallback of its own.

## Advanced: Point A Single Harness At The Gateway

You do not need this provider to use the gateway from one harness only. A plain Claude or Codex
provider with the gateway's origin and key in its Environment variables also works, and its Models
tab then offers **Refresh models from gateway** to import the catalog by hand. Use it when you want
one harness, one catalog, and full control of the environment.
