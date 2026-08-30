/**
 * Instructions RAS Code adds to an agent's system prompt, independent of which
 * provider is running the turn. Adapters with a prompt channel append these
 * verbatim; adapters without one (the ACP providers and OpenCode) carry no RAS
 * Code instructions at all, so nothing here may be load-bearing for correctness.
 *
 * @module SharedProviderInstructions
 */

/**
 * Where to write an image so the reader can actually see it.
 *
 * A client is frequently on a different machine than the environment running
 * the agent, and RAS Code only serves markdown images that resolve inside the
 * project directory. An agent that drops a screenshot in /tmp and links it
 * produces a placeholder for the reader and has no way to notice.
 */
export const IMAGE_SHARING_INSTRUCTIONS = `## Sharing images with the user

The person reading your replies is often on a different machine than the one you are running on, so they see an image only if RAS Code can serve it for them, and it will only serve images that live inside the project directory.

Write screenshots and diagrams under the project directory, preferring a gitignored path, then link them with a normal markdown image. Do not commit them. An image stored anywhere else, including /tmp and any home directory, renders for the reader as "Image is outside the project folder" and shows them nothing.

Supported formats: .png, .jpg, .jpeg, .gif, .webp, .avif, .svg, .ico.`;
