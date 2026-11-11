# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the **Linky** meters (PDL) of Enedis through the public API of the
community gateway **MyElectricalData** (`www.myelectricaldata.fr`, Swagger at
`/docs`, the user's token in `Authorization`): the contract data (off-peak
hours, subscribed power), the energy of each day (shown only), the load curve (the only data priced), the daily
peak power and production. It feeds the `linky-offpeak` tariff calendar and
ships the `linky-peak-offpeak` contract template (rules mode). **Read-only.**
Unofficial: not affiliated with Enedis nor MyElectricalData. Written from the
Swagger only (the MyElectricalData repositories carry no clear license: never
copy nor port their code).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
node --test --test-name-pattern "calendar"      # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run mutants                           # mutation check (scripts/mutants.json), use memcap
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers the handlers)
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        MedApp: pace, quotas, /data, reads, publications,
                                  off-peak calendar, status, test button
src/med/client.js                 the only network access: GET, bounded, errors without secrets
src/med/model.js                  answers -> days, half hours, peaks, contract (pure)
src/offpeak.js                    off-peak hours -> calendar slots (pure)
src/devices.js                    the devices and feature keys (pure)
src/time.js                       local time of France (Europe/Paris), pure
src/config.js                     the form, normalized
src/store.js                      /data/myelectricaldata.json
src/constants.js                  endpoint, pace, quotas, bounds, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: config, action, calendar, contract template
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys
scripts/                          cover.png generator, mutation runner and list
```

## Rules

- **Keys are forever too**: the external ids `pdl:<hash>` (16 hex of an
  HMAC-SHA-256 of the PDL under the `id_key` kept in the Gladys config outside
  the form, see `keyOf`; never an unkeyed hash, never the key in /data or a
  log), the `FEATURE` keys of `src/devices.js`, the calendar key
  `linky-offpeak` and its values `offpeak` / `peak` (its granularity
  `thirty_minutes` can never change), the template key `linky-peak-offpeak`
  and its inputs.
- **Never the token nor the PDL number** in a log, the status, an error
  message, an id or `/data` (the last 4 digits only, in names).
- **Read-only**: never add a write to the user's account.
- **Be polite with the gateway** (free, with quotas): one read a day, only the
  days not yet published, at most 12 requests per meter and per day counted
  in /data before each request, one request at a time, 3 s apart.
- **Energy**: no index; each day published once (marks in /data); never a
  value guessed (an unreadable answer, text, a conflict: left out).

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
