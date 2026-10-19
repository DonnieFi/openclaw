# Cloudflare Clef decision provider

Source-checkout-only OpenClaw plugin for Cloudflare Clef, Clef Flash, and Clef
Omni using the Gateway user's existing `cf` CLI login. It registers Decision
models, not chat models. Supported evidence is text, JSON, or one embedded PNG,
JPEG, or WebP image with text; supported questions are Boolean, Choice, and Score.
Audio/video, multiple images, list, sort, and tags are not supported.

## Host compatibility and publication

This candidate requires the prepared V2 Decision provider API, including
`DecisionProviderV2` and `api.runtime.decisions.evaluateV2`. The published
OpenClaw `2026.10.4` and `2026.10.10-beta.2` packages do not provide this contract.
Neither version number is a compatibility floor for this plugin. A newer beta
label alone does not establish V2 support.

On these V1-only hosts, manifest discovery can show the plugin as loaded and its
models in the Decision picker even though the provider cannot register. Native
`decision_evaluate` then returns `unavailable/not-configured`. Check the host's
Decision contract before changing CLI credentials or reinstalling the plugin.
Do not relabel the V2 provider as V1: its prepared auth and model context differ.

No compatible released host floor has been established. This package is private,
and both npm and ClawHub publication are disabled. The package deliberately omits
install/catalog specifications and compatibility ranges rather than advertising
support for a released host that cannot load it. Before publishing, verify the
plugin against a released host containing the required API, record that tested
release in `openclaw.install.minHostVersion` and `openclaw.compat.pluginApi`,
restore the install metadata, and enable publication through the normal release
workflow. Do not invent a future release number.

For now, use a matching source checkout that contains the prepared V2 runtime:

```bash
cf auth login
cf auth whoami
openclaw plugins install --link ./extensions/cloudflare-clef
```

Run `cf` authentication commands as the Gateway OS user. The adapter does not copy
CLI credentials into plugin config. Configure an absolute `binaryPath` and reload
plugins through plugin management; select `cloudflare-clef/clef`,
`cloudflare-clef/clef-flash`, or `cloudflare-clef/clef-omni` in the Decision picker.

See [the full setup, API, limits, and failure reference](https://docs.openclaw.ai/plugins/cloudflare-clef).

## Verification

```bash
pnpm test:extension cloudflare-clef
```

Live verification is opt-in, uses the CLI account, and incurs provider charges.
See the full reference for the live test command and environment selectors.
