# MyElectricalData (Linky) pour Gladys

Intégration non officielle, sans lien avec Enedis ni avec MyElectricalData.

> **État** : cette intégration n'a jamais été testée avec un vrai compteur Linky. Elle est écrite d'après la
> description publique de l'API de MyElectricalData (son Swagger, version 1.5.15) et les formats des données
> Enedis. Vos retours sont les bienvenus.

[MyElectricalData](https://www.myelectricaldata.fr/) est une passerelle communautaire gratuite vers les
données Enedis de votre compteur Linky. Cette intégration lit, pour chaque compteur (PDL) saisi :

- l'**énergie de chaque jour** (kWh), affichée sur l'appareil (une valeur datée par jour) : elle
  n'alimente jamais les coûts de Gladys ;
- sur demande, la **consommation par demi-heure** (courbe de charge) : seule donnée qui alimente les coûts
  du suivi énergétique et les contrats d'énergie ;
- sur demande, la **puissance max du jour** (VA) et la **production du jour** (panneaux solaires) ;
- les **heures creuses** du compteur (son contrat Enedis), qui alimentent le calendrier tarifaire
  `linky-offpeak` du modèle de contrat « Linky heures pleines / creuses (plages du compteur) ».

Lecture seule : rien n'est jamais modifié sur votre compte ni sur votre compteur.

## Installation

1. Sur [myelectricaldata.fr](https://www.myelectricaldata.fr/), donnez votre consentement Enedis pour votre
   compteur et copiez le **jeton** que le site vous donne.
2. Dans Gladys, installez l'intégration et remplissez :
   - **Jeton MyElectricalData** : gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à
     MyElectricalData ;
   - **Numéro(s) de compteur (PDL)** : les 14 chiffres de votre PDL (facture ou écran du Linky), zéros du
     début gardés ; plusieurs séparés par des virgules (5 au plus). Le calendrier des heures creuses suit le
     **premier** ;
   - les options : **courbe de charge par demi-heure** (la collecte de la courbe de charge doit être activée
     pour votre compteur dans votre espace client Enedis), **puissance max du jour** (activée par défaut),
     **production du jour**.
3. Appuyez sur **Tester l'accès** : pour chaque compteur, la passerelle indique si l'accès est valide,
   jusqu'à quand court le consentement et combien d'appels elle a comptés.
4. Dans **Découverte**, créez l'appareil « Compteur Linky …1234 » (seuls les 4 derniers chiffres du PDL
   sont montrés). Ses données sont lues une minute plus tard : 31 jours d'énergie par jour, de puissance
   max et de production, 7 jours de courbe de charge.

## Le contrat d'énergie avec les vraies heures creuses

Créez un contrat d'énergie sur le compteur Linky depuis le modèle **« Linky heures pleines / creuses
(plages du compteur) »** et saisissez vos prix du kWh en heures pleines et en heures creuses (toutes taxes
comprises) et votre abonnement mensuel.

**Ce modèle exige l'option « courbe de charge par demi-heure ».** Seules les demi-heures alimentent les
coûts : Gladys tarifierait un total du jour comme un seul intervalle daté de minuit, au prix de la
première demi-heure du jour (tout en heures creuses avec 22h-6h) ; l'énergie de chaque jour est donc
publiée pour l'affichage seulement. Sans la courbe de charge, **aucun coût n'est calculé**, et le statut
le dit. Avec elle, chaque demi-heure est comptée à son propre prix.

Cocher ou décocher l'option ne retire jamais une fonction : l'appareil proposé dans Découverte garde
toutes les fonctions déjà créées (et leur historique). La cocher ajoute la fonction par demi-heure :
mettez l'appareil à jour dans Découverte (le statut le rappelle) ; l'énergie des jours continue d'ici là,
aucun jour n'est perdu. La courbe de charge commence 7 jours en arrière (la limite Enedis d'une
requête).

Vous ne saisissez pas les demi-heures creuses : elles viennent des données contractuelles de votre
compteur, lues chaque jour. Avec les changements Enedis de 2025-2027 (une partie des heures creuses passe
l'après-midi), les nouvelles plages de votre compteur sont reprises en un jour, sans rien changer dans
Gladys.

- Le calendrier est publié d'aujourd'hui à 6 jours plus tard, une valeur par demi-heure de l'heure légale
  française (46 ou 50 les jours de changement d'heure).
- Une demi-heure est creuse quand les heures creuses couvrent sa minute du milieu (xx:15 ou xx:45). Un
  compteur qui bascule à 22h38 rend 22h30-23h00 creuse ; un compteur qui bascule à 22h15 rend 22h00-22h30
  creuse et 06h00-06h30 pleine. Les plages exactes sont affichées sur l'appareil (paramètre
  `offpeak_hours`).
- Les jours entre deux lectures qui donnent les mêmes plages sont remplis avec elles (31 jours au plus).
  Quand les plages changent, seuls les jours à partir de la lecture prennent les nouvelles.
- Une demi-heure sans valeur de calendrier (intégration arrêtée plus de 6 jours, contrat qui commence avant
  l'installation) est comptée au prix des **heures pleines** : Gladys ne devine jamais une heure creuse.
- Si le compteur n'a pas d'heures creuses dans son contrat Enedis, ou si elles ne peuvent pas être lues,
  le calendrier n'est pas alimenté et le statut le dit.
- Si une autre intégration déclare déjà le calendrier `linky-offpeak`, celle-ci ne l'alimente pas.

## Fréquence et quotas

La passerelle est un service gratuit : l'intégration demande peu.

- Une lecture par jour, à partir de 9h00 (heure de France ; une minute entre 9h00 et 11h00 propre à votre
  installation), qui ne demande que les jours pas encore publiés. Enedis donne les données d'un jour le
  lendemain matin.
- Tant qu'hier manque : nouvel essai 3 heures plus tard, 3 lectures ordinaires par jour au plus ; puis le
  lendemain matin. Les lectures après une pause, un nouvel appareil ou une configuration changée
  s'ajoutent, mais le plafond ci-dessous tient toujours.
- Un nouvel appareil, ou un nouveau jeton ou compteur dans la configuration : lecture une minute plus tard.
- 12 requêtes au plus par compteur et par jour, comptées avant chaque requête et gardées dans `/data` (un
  redémarrage ne remet pas le compte à zéro).
- Une réponse « ralentissez » (429) met toutes les requêtes en pause, le temps demandé (sinon 1 heure, puis
  2, 4, jusqu'à 6 heures) ; une requête déjà en file est retenue aussi. Une erreur de la passerelle (5xx)
  sur une route d'un compteur (courbe de charge non collectée, par exemple) fait attendre cette route :
  elle est réessayée à la lecture ordinaire suivante, jamais avant 15 minutes (doublées jusqu'à 6 heures,
  revenues à 15 minutes après un succès), et le statut donne l'heure réelle de cette lecture. Les autres
  routes et compteurs continuent, et chaque lecture commence par un autre compteur. Quand rien n'a
  répondu et que plusieurs routes (ou un contrat) sont en erreur, toutes les requêtes sont en pause
  (15 minutes, doublées jusqu'à 6 heures). Une pause est gardée au redémarrage ; celle qui finit la nuit
  attend la lecture du matin.
- Une requête en file quand une pause commence n'est pas envoyée.
- Le bouton de test demande une fois par compteur, au plus une fois par minute.

## Ce qui est publié, et quand

- **Énergie du jour** : chaque jour une fois, une valeur datée (minuit local) affichée sur l'appareil,
  jamais tarifée (pas d'index : rien ne peut baisser). Un jour corrigé plus tard par Enedis n'est pas
  republié. Après un arrêt, 92 jours au plus sont rattrapés. Un jour absent d'une réponse arrête la
  publication à cet endroit : lui et les jours suivants sont redemandés à la lecture suivante (Enedis est
  parfois en retard) ; un jour toujours absent 5 jours plus tard est abandonné.
- **Consommation par demi-heure** : seule consommation envoyée aux coûts (consommation datée de Gladys) ;
  jours entiers seulement (chaque demi-heure du jour connue une fois) ;
  une courbe horaire est coupée en deux moitiés, une courbe à 10 ou 15 minutes additionnée. Les 7 derniers
  jours au plus (la limite Enedis d'une requête) : un trou plus long n'est pas comblé.
- **Puissance max et production** : états datés (l'heure du pic ; minuit local pour la production), par
  lots de 100, 250 par minute au plus. Après un long arrêt, seuls les 31 derniers jours sont rattrapés. Un
  pic à 0 est écarté.
- Une valeur qui n'est pas un nombre, un jour donné deux fois avec deux valeurs, une réponse sur un autre
  compteur ou dans une autre unité : écartés, jamais publiés comme 0.
- Gladys doit être réglé sur le fuseau Europe/Paris : les jours d'Enedis sont des jours de France.

## Refus et erreurs

- **Refus** : quand le contrat de **chaque** compteur reçoit 401 ou 403 dans la même lecture, le jeton est
  tenu pour refusé : plus aucune requête n'est envoyée, jusqu'à un **Tester l'accès** réussi ou un
  changement du jeton ou des numéros de compteur, même intégration arrêtée (un PDL mal saisi est refusé
  lui aussi). Un 401/403 sur une route de données, ou sur un seul compteur, n'est pas un refus (le statut nomme
  le compteur et la route).
- Le jeton et le numéro de PDL ne sont jamais écrits dans les journaux, le statut ni `/data`. `/data` garde
  une empreinte à clé de chaque compteur, le dernier jour publié par sorte de donnée, les heures creuses
  lues, le compte des requêtes du jour, la pause et 8 bits d'une empreinte salée d'un jeton refusé.
- Les identifiants d'appareils viennent d'une clé créée une fois et gardée dans la configuration de Gladys
  (hors formulaire).
- Les appareils non lus depuis Gladys au démarrage : nouvel essai 30 secondes plus tard (doublé jusqu'à
  5 minutes) ; le statut le dit et rien n'est publié d'ici là.
- `/data` illisible, ou dont l'écriture échoue : les lectures attendent une heure après un démarrage (le
  compte du jour n'est pas sûr) et le statut le dit. Une écriture lente qui aboutit ne compte pas.

## Limites

- Jamais testée avec un vrai compteur ; l'horodatage de la courbe de charge (fin de chaque intervalle,
  comme Enedis le documente) est vérifié sur chaque réponse, pas sur des données réelles.
- Les jours avant l'installation sont comptés au prix des heures pleines par le modèle.
- Le modèle exige la courbe de charge : un compteur sans collecte de courbe n'a aucun coût calculé.
- Plusieurs compteurs : le calendrier suit le premier seulement.

## Données

Données d'Enedis, relayées par MyElectricalData avec votre consentement. MyElectricalData est un projet
communautaire sans lien avec Enedis.
