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

Connecting this provider also makes it an automatic usage fallback for subscription providers.
There is nothing else to configure. When a subscription runs out, RAS Code offers the gateway only
if its catalog contains the exact same model.

If you also have a second subscription of the same provider that can run the model, RAS Code offers
that one first. You already paid for it, and the gateway bills per token.

Started Claude threads can keep their conversation state because the gateway's Claude side shares
Claude's continuation identity. Every other shape moves too, but the gateway cannot resume the
harness conversation, so the thread restarts there and its transcript is replayed as context in the
next prompt. The offer says so before you accept, and the same replay happens on the way back to
the subscription.

Accepting the offer keeps the thread's original provider icon and model label, with a quiet
`via PostHog AI Gateway` indicator. RAS Code later tries the subscription again automatically.

## Advanced: Point A Single Harness At The Gateway

You do not need this provider to use the gateway from one harness only. A plain Claude or Codex
provider with the gateway's origin and key in its Environment variables also works, and its Models
tab then offers **Refresh models from gateway** to import the catalog by hand. Use it when you want
one harness, one catalog, and full control of the environment.
