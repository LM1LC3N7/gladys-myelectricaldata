# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the Linky meters (PDL) read through the public API of the
  MyElectricalData community gateway with the user's token, read-only.
- One device per meter: the energy of each day (dated states, shown only,
  never priced), on request the 30-minute load curve (the only consumption
  sent to the costs, publishEnergyConsumption), the daily peak power and the
  daily production; each day once, a missing day asked again (given up after
  5 days). Ticking or unticking an option never removes a created feature.
- The `linky-offpeak` tariff calendar, fed every day with the real off-peak
  hours of the first meter, and the "Linky peak / off-peak (hours of the
  meter)" contract template priced by the Gladys engine from it. The template
  needs the load curve: without it, no cost is computed.
- Quotas: one read a day, again 3 hours later while yesterday is missing (3 a
  day at most), at most 12 requests per meter and per day counted in `/data`
  before each request, pauses on 429 and 5xx kept across a restart.
- A test button checking the access, consent and quota of every meter.
