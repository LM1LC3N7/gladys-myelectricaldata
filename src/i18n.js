// -----------------------------------------------------------------------------
// Runtime texts, English and French: device and feature names, the status of
// the configuration screen, the answers of the test button. A PDL is only
// ever named by its last 4 digits.
// -----------------------------------------------------------------------------

const TEXTS = {
  devicePdl: { en: 'Linky meter …{suffix}', fr: 'Compteur Linky …{suffix}' },
  featureDaily: { en: 'Daily consumption', fr: 'Consommation du jour' },
  featureCurve: { en: 'Consumption (30 min)', fr: 'Consommation (30 min)' },
  featureMaxPower: { en: 'Daily peak power', fr: 'Puissance max du jour' },
  featureProduction: { en: 'Daily production', fr: 'Production du jour' },

  // Status of the configuration screen.
  missing: {
    en: 'Enter your MyElectricalData token and the number of your meter (PDL, 14 digits).',
    fr: 'Saisissez votre jeton MyElectricalData et le numéro de votre compteur (PDL, 14 chiffres).',
  },
  missingToken: {
    en: 'Enter your MyElectricalData token (given on myelectricaldata.fr once the Enedis consent is done).',
    fr: 'Saisissez votre jeton MyElectricalData (donné sur myelectricaldata.fr une fois le consentement Enedis donné).',
  },
  missingPdl: {
    en: 'Enter the number of your meter (PDL, 14 digits, on your bill or on the Linky screen).',
    fr: 'Saisissez le numéro de votre compteur (PDL, 14 chiffres, sur votre facture ou l’écran du Linky).',
  },
  badToken: {
    en: 'The token does not look like one (8 to 512 characters, no space): nothing is sent.',
    fr: 'Le jeton n’en a pas la forme (8 à 512 caractères, sans espace) : rien n’est envoyé.',
  },
  badPdl: {
    en: 'A meter number is not 14 digits (keep the leading zeros): nothing is sent.',
    fr: 'Un numéro de compteur n’a pas 14 chiffres (gardez les zéros du début) : rien n’est envoyé.',
  },
  tooManyPdl: {
    en: 'At most 5 meters: nothing is sent.',
    fr: '5 compteurs au plus : rien n’est envoyé.',
  },
  malformed: {
    en: 'A field holds a control character or is too long: nothing is sent.',
    fr: 'Un champ contient un caractère de contrôle ou est trop long : rien n’est envoyé.',
  },
  refused: {
    en: 'MyElectricalData refused the token for every meter (401/403). Check the token and the Enedis consent on myelectricaldata.fr, then press Test. Nothing is asked until then.',
    fr: 'MyElectricalData a refusé le jeton pour chaque compteur (401/403). Vérifiez le jeton et le consentement Enedis sur myelectricaldata.fr, puis appuyez sur Tester. Rien n’est demandé d’ici là.',
  },
  idKeyNotStored: {
    en: 'Gladys could not store the key of the device ids of this integration: nothing is read until it is stored. Next try at {time}.',
    fr: 'Gladys n’a pas pu enregistrer la clé des identifiants d’appareils de cette intégration : rien n’est lu tant qu’elle ne l’est pas. Nouvel essai le {time}.',
  },
  rateLimited: {
    en: 'MyElectricalData asked to slow down (quota): next request on {time}.',
    fr: 'MyElectricalData a demandé de ralentir (quota) : prochaine requête le {time}.',
  },
  server: {
    en: 'MyElectricalData is having trouble ({code}): next request on {time}.',
    fr: 'MyElectricalData a un problème ({code}) : prochaine requête le {time}.',
  },
  starting: {
    en: 'Starting: {count} meter(s), first read on {time}.',
    fr: 'Démarrage : {count} compteur(s), première lecture le {time}.',
  },
  connected: {
    en: 'Connected: {count} meter(s), read on {time}; next read on {next}.',
    fr: 'Connecté : {count} compteur(s), lu(s) le {time} ; prochaine lecture le {next}.',
  },
  failing: {
    en: 'MyElectricalData did not answer the read of {time}: next read on {next}.',
    fr: 'MyElectricalData n’a pas répondu à la lecture du {time} : prochaine lecture le {next}.',
  },
  meterProblems: {
    en: ' Meter …{suffix}: {codes}.',
    fr: ' Compteur …{suffix} : {codes}.',
  },
  calendar: {
    en: ' Off-peak hours of …{suffix}: {hours}, calendar published up to {until}.',
    fr: ' Heures creuses de …{suffix} : {hours}, calendrier publié jusqu’au {until}.',
  },
  noOffpeak: {
    en: ' Meter …{suffix} has no off-peak hours in its Enedis contract: the off-peak calendar is not fed.',
    fr: ' Le compteur …{suffix} n’a pas d’heures creuses dans son contrat Enedis : le calendrier des heures creuses n’est pas alimenté.',
  },
  badOffpeak: {
    en: ' The off-peak hours of meter …{suffix} could not be read: the off-peak calendar is not fed.',
    fr: ' Les heures creuses du compteur …{suffix} n’ont pas pu être lues : le calendrier des heures creuses n’est pas alimenté.',
  },
  calendarOwned: {
    en: ' Another integration already feeds the linky-offpeak calendar: this one does not.',
    fr: ' Une autre intégration alimente déjà le calendrier linky-offpeak : celle-ci ne le fait pas.',
  },
  calendarFailed: {
    en: ' Gladys did not take the off-peak calendar: again at the next daily read.',
    fr: ' Gladys n’a pas pris le calendrier des heures creuses : nouvel essai à la prochaine lecture du jour.',
  },
  storage: {
    en: ' /data cannot be read or written: the days already published and the daily count of requests are not kept; reads wait an hour after a start.',
    fr: ' /data ne peut pas être lu ou écrit : les jours déjà publiés et le compte quotidien des requêtes ne sont pas gardés ; les lectures attendent une heure après un démarrage.',
  },
  devicesUnread: {
    en: ' The devices could not be read from Gladys: tried again soon, nothing is published meanwhile.',
    fr: ' Les appareils n’ont pas pu être lus depuis Gladys : nouvel essai bientôt, rien n’est publié d’ici là.',
  },
  dailyHeld: {
    en: ' A "Linky peak / off-peak" contract needs the 30-minute load curve: the daily consumption is held (Gladys would price each whole day at the price of its first half hour). Enable the load curve option.',
    fr: ' Un contrat « Linky heures pleines / creuses » a besoin de la courbe de charge par demi-heure : la consommation du jour est retenue (Gladys compterait chaque journée entière au prix de sa première demi-heure). Activez l’option courbe de charge.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: next try soon.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai bientôt.',
  },

  // Test button.
  testOk: {
    en: 'Meter …{suffix}: access valid, consent until {end}, {calls}/{limit} calls counted by the gateway.',
    fr: 'Compteur …{suffix} : accès valide, consentement jusqu’au {end}, {calls}/{limit} appels comptés par la passerelle.',
  },
  testQuota: {
    en: 'Meter …{suffix}: the gateway quota is reached ({calls}/{limit}).',
    fr: 'Compteur …{suffix} : le quota de la passerelle est atteint ({calls}/{limit}).',
  },
  testInvalid: {
    en: 'Meter …{suffix}: the gateway says the access is not valid: renew the Enedis consent on myelectricaldata.fr.',
    fr: 'Compteur …{suffix} : la passerelle indique un accès non valide : renouvelez le consentement Enedis sur myelectricaldata.fr.',
  },
  testBanned: {
    en: 'Meter …{suffix}: the gateway has banned this access.',
    fr: 'Compteur …{suffix} : la passerelle a banni cet accès.',
  },
  testMeterFailed: {
    en: 'Meter …{suffix}: not checked ({code}).',
    fr: 'Compteur …{suffix} : non vérifié ({code}).',
  },
  testNotReady: {
    en: 'Not ready yet (the configuration is being read): try again in a moment.',
    fr: 'Pas encore prêt (la configuration est en cours de lecture) : réessayez dans un instant.',
  },
  testTooSoon: {
    en: 'Tested less than a minute ago: try again in a moment.',
    fr: 'Testé il y a moins d’une minute : réessayez dans un instant.',
  },
  testPaused: {
    en: 'Not sent: MyElectricalData asked to wait until {time}.',
    fr: 'Rien envoyé : MyElectricalData a demandé d’attendre jusqu’au {time}.',
  },
  testFailed: {
    en: 'MyElectricalData could not be reached ({code}): nothing changed.',
    fr: 'MyElectricalData n’a pas pu être joint ({code}) : rien n’a changé.',
  },
};

/** A text in a language, with its {placeholders} filled. */
export function t(key, language = 'en', values = {}) {
  const entry = TEXTS[key];
  const text = entry?.[language] ?? entry?.en ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

/** Both languages of a text: { en, fr }. */
export const both = (key, values) => ({ en: t(key, 'en', values), fr: t(key, 'fr', values) });

export const ALL_TEXTS = TEXTS;
