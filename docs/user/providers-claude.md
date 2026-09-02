# Claude

This guide is for people who want to use more than one Claude setup in RAS Code. For Codex, see
[Codex](./providers-codex.md). For first-time setup, see [Install RAS Code](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In RAS Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means RAS Code uses Claude Code's normal config directory.

When you set this field, RAS Code points Claude Code at that directory with the
`CLAUDE_CONFIG_DIR` environment variable. It does not change `HOME`, so your system keychain and
the rest of your environment stay as they are.

## Reduce Context Usage

In Settings, open your Claude provider and set **Auto-compact after** to a token count between
`100000` and `1000000`. For example, `300000` compacts the conversation into a summary once it
reaches about 300,000 tokens, without changing the model's context window. Leave the field
empty to keep Claude Code's default behavior.

On web and desktop, when you return to an older Claude thread with a large context, RAS Code
offers to compact the conversation before you continue. You can also select **Compact context**
from the context meter. On every client, you can enter `/compact` in the message composer, and
Claude can show its own resume prompt when you continue an old session.

## Where Claude Skills Are Loaded

RAS Code looks for Claude skills in the Claude config directory's `skills` folder and
`<workspace>/.claude/skills`, the two places Claude Code loads them from.

A skill set to `off` in Claude Code's `skillOverrides` is left out of both composer menus. A skill
marked `disable-model-invocation` still appears, because you start it yourself when you pick it.
Claude Code runs one skill per message; when a message names several, the last one runs directly and
Claude starts the others through its Skill tool, which refuses skills marked
`disable-model-invocation`.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In RAS Code Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Setting `HOME` writes the login to
`~/.claude_personal_home/.claude`, which is not where RAS Code looks.

Then add another Claude provider in RAS Code:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

RAS Code only offers Claude providers that use the same config directory for an existing thread. A
different config directory is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its config directory, so RAS Code keeps separate config directories isolated
instead of trying to share part of the state.

A usage limit is the one exception.

## Switching Accounts When One Runs Out

RAS Code does this for you. When the account running a thread hits its usage limit, it asks whether
to continue on your other Claude account or wait for the reset, and names the account it would move
to. Answer once per limit; every later turn in that window keeps going there without asking.

Because each account has its own config directory, the other account cannot resume the Claude
conversation. RAS Code starts a fresh session there and carries the recent transcript into the next
prompt, so older detail can be lost. The question says so before you accept. The same replay
happens on the way back, which RAS Code tries on the first turn after your original account resets.

RAS Code skips an account that is signed in to the same login as the exhausted one, one that is out
of quota itself, and one you have not logged into.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in RAS Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. RAS Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## PostHog AI Gateway fallback

Add and connect a [PostHog AI Gateway](./providers-posthog-gateway.md) provider once. There is no
fallback setting on Claude. When the Claude subscription reaches its usage limit, RAS Code offers
to continue through the gateway if it has the exact same model and can preserve the thread's
conversation state. A second Claude subscription that can run the model is offered first, because
the gateway bills per token.

After you accept, the thread stays visually attached to Claude and its original model. A quiet
`Using <model> via PostHog AI Gateway` label and a timeline event explain how turns are being sent.
RAS Code tries the subscription again on the first turn after the reset. It records the successful
return, or resumes the already-approved gateway without asking again if the subscription is still
exhausted.

RAS Code does not substitute another model. If the gateway does not advertise the exact model, it
does not offer the switch.

## PostHog AI Gateway

The PostHog AI Gateway is its own provider now, not a Claude preset. It serves the whole gateway
catalog and routes each model to the harness that can run it. See
[PostHog AI Gateway](./providers-posthog-gateway.md).

If you still have a `claude_posthog_gateway` provider from the old preset, it keeps working as an
ordinary Claude provider. Add the new provider when you want the rest of the catalog, then remove
the old instance.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

RAS Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream project's README for the router's own install, startup, and configuration
steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.
