# MyElectricalData (Linky) for Gladys

Unofficial integration, not affiliated with Enedis nor with MyElectricalData.

> **Status**: this integration has never been tested with a real Linky meter. It is written from the
> public API description of MyElectricalData (its Swagger, version 1.5.15) and from the Enedis data
> formats. Your feedback is welcome.

[MyElectricalData](https://www.myelectricaldata.fr/) is a free community gateway to the Enedis data of
your Linky meter. This integration reads, for each meter (PDL) you enter:

- the **daily consumption** (kWh), published to the Gladys energy monitoring;
- on request, the **30-minute consumption** (load curve), for the time-of-use contracts;
- on request, the **daily peak power** (VA) and the **daily production** (solar panels);
- the **off-peak hours** of the meter (its Enedis contract), which feed the `linky-offpeak` tariff
  calendar of the "Linky peak / off-peak (hours of the meter)" contract template.

Read-only: nothing is ever changed on your account nor on your meter.

## Setup

1. On [myelectricaldata.fr](https://www.myelectricaldata.fr/), give your consent to Enedis for your
   meter and copy the **token** the site gives you.
2. In Gladys, install the integration and fill in:
   - **MyElectricalData token**: kept by Gladys in its database, never shown again, sent only to
     MyElectricalData;
   - **Meter number(s) (PDL)**: the 14 digits of your PDL (bill or Linky screen), leading zeros kept;
     several separated by commas (5 at most). The off-peak calendar follows the **first** one;
   - the options: **30-minute load curve** (the load curve collection must be enabled for your meter in
     your Enedis customer area), **daily peak power** (on by default), **daily production**.
3. Press **Test the access**: for each meter, the gateway says whether the access is valid, until when
   the consent runs and how many calls it counted.
4. In **Discovery**, create the "Linky meter …1234" device (only the last 4 digits of the PDL are shown).
   Its data is read a minute later: one year of daily consumption, 7 days of load curve, 31 days of peak
   power and production.

## The energy contract with the real off-peak hours

Create an energy contract on the Linky meter from the **"Linky peak / off-peak (hours of the meter)"**
template and enter your peak and off-peak prices per kWh (taxes included) and your monthly subscription.

The off-peak half hours are not typed by you: they come from the contract data of your meter, read every
day. Under the Enedis changes of 2025-2027 (part of the off-peak hours moved to the afternoon), the new
hours of your meter are taken up within a day, with nothing to change in Gladys.

- The calendar is published from today to 6 days ahead, one value per half hour of the local time of
  France (46 or 50 on the days of the changes of time).
- A half hour is off-peak when the off-peak hours cover its middle minute (xx:15 or xx:45). A meter
  switching at 22:38 makes 22:30-23:00 off-peak; one switching at 22:15 makes 22:00-22:30 off-peak and
  06:00-06:30 peak. The exact hours are shown on the device (`offpeak_hours` parameter).
- The days between two reads that give the same hours are filled with them (31 days at most). When the
  hours change, only the days from the read on get the new ones.
- A half hour without calendar value (the integration stopped for more than 6 days, a contract starting
  before the installation) is priced at the **peak** price: Gladys never guesses an off-peak hour.
- If the meter has no off-peak hours in its Enedis contract, or if they cannot be read, the calendar is
  not fed and the status says so.
- If another integration already declares the `linky-offpeak` calendar, this one does not feed it.

## How often, and the quotas

The gateway is a free service: the integration asks for little.

- One read a day, from 09:00 (local time of France; a minute between 09:00 and 11:00 proper to your
  installation), asking only for the days not yet published. Enedis gives the data of a day the next
  morning.
- While yesterday is missing: again 3 hours later, at most 3 reads a day; then the next morning.
- A new device, or a new token or meter in the configuration: read a minute later.
- At most 12 requests per meter and per day, counted before each request and kept in `/data` (a restart
  does not reset the count).
- A "slow down" answer (429) pauses every request, for the time asked (or 1 hour, then 2, 4, up to
  6 hours); a gateway error (5xx) pauses for 15 minutes, doubled up to 6 hours. The pause is kept across a
  restart.
- The test button asks once per meter, at most once a minute.

## What is published, and when

- **Daily consumption**: each day once, through the dated consumption of Gladys (no index: nothing can
  go down). A day corrected later by Enedis is not published again.
- **30-minute consumption**: whole days only (every half hour of the day known once); an hourly curve is
  split in two halves, a 10 or 15-minute curve summed. At most the last 7 days (the Enedis limit of one
  request): a gap longer than that is not filled.
- **Peak power and production**: dated states (the time of the peak; the local midnight for the
  production), at most 250 a minute. A peak of 0 is left out.
- A value that is not a number, a day given twice with two values, an answer about another meter or in
  another unit: left out, never published as 0.
- Gladys should run in the Europe/Paris time zone: the days of Enedis are days of France.

## Refusals and errors

- **Refused**: when the contract of **every** meter is answered 401 or 403 in the same read, the token is
  taken as refused: no request is sent any more, until you press **Test the access** with success or
  enter another token. A 401/403 on a data route, or on one meter only, is not a refusal (the status
  names the meter and the route).
- The token and the PDL number are never written in the logs, the status nor `/data`. `/data` keeps a
  keyed hash of each meter, the last day published per kind of data, the off-peak hours read, the count
  of requests of the day, the pause and 8 bits of a salted hash of a refused token.
- The device ids come from a key made once and kept in the Gladys configuration (not in the form).

## Limits

- Never tested with a real meter; the stamp of the load curve (end of each interval, as Enedis documents
  it) is checked against each answer but not against real data.
- The days before the installation are priced at the peak price by the template.
- Several meters: the calendar follows the first one only.

## Data

Data from Enedis, relayed by MyElectricalData under your consent. MyElectricalData is a community
project not affiliated with Enedis.
