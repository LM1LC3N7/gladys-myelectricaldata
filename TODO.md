# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Linky meter and a MyElectricalData
      token: Test button, Discovery, the 31 days of energy per day, a contract
      from the template priced with the calendar, a day later.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store fields left out of the manifest on purpose (Louis' rule):
      `countries: ["FR"]`, keywords `linky`, `enedis`, `heures creuses`,
      `myelectricaldata`.

## To confirm on a real meter (built from the Swagger only)

- [ ] The errors of the gateway: a wrong token (401, 403, or a 200 with an
      error body?), a consent ended, the quota reached (429, 409?). Only 200
      and 422 are in the Swagger; 401/403 on the contract of every meter is
      taken as a refusal, anything else as passing.
- [ ] The quota of the gateway (`quota_limit` of `/valid_access`) and whether
      `/valid_access` itself counts. The integration stays far below (12 a
      day per meter at most, 2 to 4 in a normal day).
- [ ] The load curve stamps: Enedis documents the END of each interval; an
      answer stamped from the start of the window is read as start stamps.
      The two hours of the autumn change are told apart by their order.
- [ ] `end` of the date windows taken as exclusive (Enedis convention).
- [ ] `offpeak_hours` format, the afternoon hours of the 2025-2027 changes,
      and whether a seasonal programme shows other hours in summer.
- [ ] The daily peak power date: with the time of the peak or the day only
      (both handled).
- [ ] The `/cache` routes (the gateway keeps the data 30 days for them): not
      used, the user's data is not stored there by this integration.

## Later

- [ ] A calendar per meter when several PDL have off-peak hours (the calendar
      keys are global: one `linky-offpeak` per Gladys).
- [ ] A delegated Tempo / EJP template from the colours the gateway serves.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Read-only v1, no delegated pricing: the template is priced by the Gladys
  engine with a `thirty_minutes` calendar (`offpeak` / `peak`); a half hour
  is off-peak when its middle minute is (8 hours stay 8 hours for a :15
  start); a day without calendar is priced at the peak price.
- The calendar is published from today to 6 days ahead (the core accepts 7);
  the days since the last publication are filled only when the hours read are
  the same (31 days at most), never guessed otherwise.
- No index: the consumption goes through publishEnergyConsumption (daily, and
  30-minute whole days), each day once (a mark per meter and kind in /data);
  a correction by Enedis of a published day is not taken. Peak power and
  production are dated states, throttled to 250 a minute.
- Device ids: HMAC of the PDL under a key kept in the Gladys config
  (`id_key`, as gladys-octopus-germany); the name shows the last 4 digits.
- Refusal only when the contract of every meter answers 401/403 in one read;
  lifted by Test, a new token or new meter numbers.
- Review r2 (coordinator's design): the energy of each day is a dated state
  of type `index-yesterday`, shown only, never priced (the core would price a
  daily consumption as one interval at the price of its midnight half hour);
  only the 30-minute load curve goes through publishEnergyConsumption, so the
  HP/HC template needs it and without it no cost is computed. Discovery keeps
  every created feature (options never remove one). A 5xx on one route waits
  for that route only; the gateway is paused when nothing answered and several
  routes (or a contract) failed. Dated states by batches of 100.
- Gladys `>=5.2.0` (publishEnergyConsumption and the energy contracts).
