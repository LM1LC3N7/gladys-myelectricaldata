# MyElectricalData (Linky) for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**Linky** meters of Enedis (France), through the free community gateway
[MyElectricalData](https://www.myelectricaldata.fr/). Not affiliated with
Enedis nor with MyElectricalData. With the token the gateway gives once your
Enedis consent is done, it reads for each meter (PDL):

- the energy of each day, shown on the device only (never priced), and on
  request the 30-minute load curve, the only data that feeds the Gladys
  energy costs;
- on request, the daily peak power and the daily production;
- the off-peak hours of the meter, which feed the `linky-offpeak` tariff
  calendar of the contract template **Linky peak / off-peak (hours of the
  meter)**: the off-peak half hours of the contract are the real ones of the
  meter, and follow the 2025-2027 Enedis changes by themselves.

**Read-only**, one read a day, at most 12 requests per meter and per day.
Never tested with a real Linky meter yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json)
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). Written from the public API description of
MyElectricalData only; no code of the MyElectricalData projects is used: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
