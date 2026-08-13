# Voxlire

Un lecteur de livres à voix haute qui tourne **entièrement dans le navigateur**,
sans compte, sans serveur, et sans connexion une fois installé.

Vous lui donnez un EPUB ou un texte collé ; il le lit avec une vraie voix
neuronale, en respectant les silences de la ponctuation.

👉 **[Ouvrir Voxlire](https://gamesntiana-source.github.io/voxlire/)**

Installable comme une application depuis Android, tablette ou PC.

---

## Ce qui se passe quand vous appuyez sur Lire

```
texte  →  prosody.js   découpe en phrases, décide les silences et la mélodie
       →  nombres.js   « 1789 » devient « mille sept cent quatre-vingt-neuf »
       →  phonemes.js  le français devient des phonèmes IPA
       →  piper.js     un réseau de neurones en fait du son
       →  silence.js   on rogne, on fond
       →  player.js    tout est posé sur l'horloge audio, sans trou
```

## Trois choix qui font la différence

**La prononciation ne se devine pas.** Un moteur de règles écrit à la main
plafonne autour de 92 % de mots justes — soit plusieurs mots écorchés par page.
Embarquer eSpeak NG en WebAssembly coûterait 18 Mo. Voxlire prend une troisième
voie : eSpeak NG est exécuté **hors ligne**, une fois, sur 345 464 mots
français ; on ne livre que les 67 209 mots où il contredit nos règles. Résultat :
1,5 Mo, et une prononciation identique à celle sur laquelle les modèles ont été
entraînés. Un mot absent du lexique est un mot que les règles disent déjà juste.

**Les silences sont mesurés, pas devinés.** Le modèle emballe chaque phrase
dans 270 ms de silence variable ; on le rogne pour reprendre la main. Les durées
suivent ce qu'on observe chez les locuteurs : une virgule tient entre 380 et
670 ms, un point entre 810 et 1240, et au-delà d'une seconde un silence cesse
d'être entendu comme une pause. Les virgules sont découpées **sur le texte** —
jamais à l'oreille dans le signal, où un creux de virgule et une pause
inter-mot se recouvrent complètement.

**La mélodie est portée par le texte.** Un modèle Piper ignore le contexte :
chaque phrase lui est donnée seule, il la rend donc toujours dans le même
registre — d'où l'effet monocorde. Voxlire attaque un paragraphe haut, redescend
sur quatre phrases, repart haut au suivant, et ralentit sur la dernière. La
transposition passe par un rééchantillonnage compensé en durée, borné à deux
demi-tons pour ne pas déplacer les formants.

## Ce que ça pèse

| | |
|---|---|
| Application + moteur | ~15 Mo, une seule fois |
| Première voix | 28 à 76 Mo selon la voix |
| Ensuite | rien, tout est en cache |

## Développement

```bash
npm run vendor     # récupère ONNX Runtime dans src/vendor/ (ignoré par git)
npm run serve      # http://localhost:8000, et l'adresse wifi pour le téléphone
npm test           # 153 tests, sans navigateur ni carte son
npm run lexique    # régénère le lexique de prononciation (demande eSpeak NG)
```

`npm run serve:isolation` ajoute les en-têtes COOP/COEP, qui débloquent les fils
WebAssembly. Utile pour mesurer le gain en local — GitHub Pages ne permet pas de
poser ces en-têtes, donc ce qui va vite ici ira moins vite en ligne.

## Licences

Le code est sous licence MIT. **Les voix ont les leurs**, et elles diffèrent :
Siwis en CC-BY, Jessica et Pierre en CC-BY-SA, Gilles en CC0, et **Tom en
AGPL-3.0**. Elles proviennent de [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)
et sont téléchargées par l'utilisateur, jamais redistribuées par ce dépôt.

## Dépendances

Une seule à l'exécution : [ONNX Runtime Web](https://onnxruntime.ai/), pour
faire tourner le réseau de neurones. Tout le reste — lecture des EPUB,
décompression ZIP, phonémisation, synthèse du souffle, ordonnancement audio —
est écrit ici.
