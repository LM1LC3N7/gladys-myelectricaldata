# Third-party notices

## MyElectricalData

This integration calls the public API of MyElectricalData
(https://www.myelectricaldata.fr/, API description at
https://www.myelectricaldata.fr/docs, version 1.5.15 read on 2026-11-11). It is
written from that description only: no code of the MyElectricalData projects is
copied, ported nor shipped (their repositories carry no clear license).

## Enedis data

The consumption, production, power and contract data are the data of the
user's meter, from Enedis, relayed by MyElectricalData under the consent the
user gave on myelectricaldata.fr. The format of the off-peak hours
(`HC (22H00-6H00)`) is the one of the Enedis Data Connect contract data.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0).
