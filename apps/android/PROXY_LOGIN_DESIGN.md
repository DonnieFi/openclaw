# Android proxy login design scope

Related: https://github.com/openclaw/openclaw/issues/162240

Status: scope only. Source analysis and design are pending. Implementation requires
approval of the proposed design. This draft changes no application behavior or
live configuration.

## Goal

Provide a native Android login flow for an OpenClaw Gateway behind Caddy HTTPS
and HTTP Basic authentication, while preserving Gateway authentication,
verified multiplayer identity, role enforcement, and device pairing.

## Requested screens

- Extend one existing Gateway setup/settings screen with **Proxy authentication:
  None / HTTP Basic** and **Configure/Edit**.
- Add one reusable proxy username/password screen with the confirmed destination,
  masked password, **Save/Continue**, **Cancel**, and **Remove**.
- Use the same flow for manual setup and QR/setup-code onboarding.
- Allow editing saved Gateways without deleting their pairing.

## Required boundaries

- Keep proxy credentials separate from Gateway token/password credentials.
- Authenticate to Caddy; never fabricate trusted user-identity headers or bypass
  Gateway roles or pairing.
- Send credentials only over verified TLS, scoped to the confirmed destination.
- Keep credentials out of URLs, logs, QR codes, exports, redirects, and requests
  to another Gateway. Store them securely.
- Preserve QR pairing data, confirm the destination, request proxy login when
  needed, and resume setup. Never silently rewrite destinations or include proxy
  passwords in QR payloads.
- Distinguish proxy login failure, TLS/network errors, Gateway rejection, expired
  setup codes, and pending pairing.
- Replace flickering retries with stable errors and bounded retry/cancel behavior.
- Check operator/chat and node connections separately. Preserve non-proxy setups.

## Design deliverables pending

- Identify the inspected commit and relevant UI, QR parser, connection-plan,
  operator/node transport, secure-storage, and reconnect owners.
- Reverify custom-header support and whether production UI callers exist.
- Produce requirements and wireframes for the two screens.
- Describe manual, QR, edit, and reconnect flows and credential lifecycle/security.
- Propose a minimal file-level implementation plan.
- Specify isolated tests using dummy credentials: QR end-to-end, wrong passwords,
  reconnect, multiple Gateways, redirects, TLS failures, role enforcement, and
  secret redaction.
- Record open decisions, blockers, and verification gaps.

## Evidence limits

The linked issue reports an onboarding limitation and unverified transport failure
attribution. This scope document does not establish the current checkout's root
cause, a working upgrade, or a working QR flow. No runtime tests have been run for
this draft. Present the completed design for approval before implementation.
