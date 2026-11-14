# Imagerie de Mars : plan de travail

Ce plan met en œuvre le brief [SpaceXR_Brief_Imagerie_Mars_Jezero_2026.docx](SpaceXR_Brief_Imagerie_Mars_Jezero_2026.docx) (version 1.0). Le pipeline est écrit dans `tools/mars/imagery/` et produit l'imagerie de la révision globale de Mars, à côté de son `elevation.json`.

## Point de départ

Déjà sur `F:/MarsData/sources` :

| Fichier                                                                             | Contenu                                                                                | Emprise mesurée                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `imagery/Mars_Viking_MDIM21_ClrMosaic_global_232m.tif`                              | Viking MDIM 2.1, RGB 8 bits, 231,5 m/px, 92160 × 46080, en bandes (non tuilé), 12,7 Go | Mars entière, cylindrique simple, sphère 3396190 m                          |
| `jezero/ctx/M20_JezeroCrater_CTXortho_mosaic_5m.tif`                                | Orthomosaïque CTX USGS, gris 8 bits, 5,0 m/px, 17766 × 20234                           | environ 77,0 à 78,6° E, 17,6 à 19,3° N (parallèle standard voisin de 18,4°) |
| `jezero/hirise/JEZ_hirise_soc_006_orthoMosaic_25cm_..._first.tif`                   | Orthomosaïque HiRISE TRN, gris 8 bits, 0,25 m/px, 85600 × 85952, 7,4 Go                | 77,22 à 77,58° E, 18,31 à 18,67° N                                          |
| `jezero/ctx/M20_JezeroCrater_CTXDEM_20m.tif`, `jezero/hirise/..._DTM_..._1m_...tif` | Les DEM déjà utilisés par l'élévation                                                  |                                                                             |

Dans `F:/MarsData/Tianwen-1`, deux produits HiRIC de Tianwen-1 (portail CLPDS), en archives RAR, projection cylindrique simple sur la sphère de 3396190 m, méridien central 110° E :

| Archive                                             | Contenu                                                     | Emprise lue dans le `.tfw` et le nom                                                          |
| --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `HX1_GRAS_HIRIC_DEM_3.5_0000_244453N1101905E_A.rar` | DEM, 3,5 m/px, TIFF de 2,9 Go (Float32 probable)            | environ 109,8 à 110,8° E, 23,5 à 26,0° N, 60 × 150 km, site d'atterrissage de Zhurong compris |
| `HX1_GRAS_HIRIC_DIM_0.7_0013_234409N1095850E_A.rar` | Orthoimage, 0,7 m/px, TIFF de 1,2 Go (gris 8 bits probable) | environ 109,8 à 110,15° E, 23,5 à 24,0° N, 20 × 30 km, au sud de Zhurong                      |

Ils ajoutent au brief une seconde région, Utopia Planitia (étape 5 bis). Le référentiel vertical du DEM (sphère ou aréoïde) n'est pas écrit dans le `.prj` : il se détermine par comparaison avec MOLA, comme pour Jezero.

Il manque Tianwen-1 MoRIC (en cours de téléchargement), HRSC MC13E, CTX V01 et HiRISE MSR 2025 (extension ouest).

Tianwen-1, contrôlé le 13/11/2026 : le HiPS du CDS répond 404 sur `alasky` et ne répond pas sur son miroir `alaskybis`, le CDS signalant une dégradation de ses services depuis un incident de cybersécurité (communication mise à jour le 9 novembre 2026). Sa fiche MocServer répond toujours. Le HiPS (512 px, ordre 7, PNG) n'est de toute façon qu'un rééchantillonnage du produit CLPDS : la source à ingérer est le GeoTIFF d'origine. Le portail CLPDS, atteint par les deux DOI, propose la mosaïque globale en un GeoTIFF de 46 Go (`HX1_GRAS_MoRIC_DOM_076m_Global_00N00E_A.tif`, DOI `..._Global.vA`) ou en 36 feuillets de 2,2 Go environ (`..._D06_15S040E_A.tif`, DOI `..._Charts.vA`). D'après le nommage, Jezero tombe dans le feuillet C07 (0 à 30° N, 60 à 100° E), à confirmer. Le téléchargement passe par le bouton du portail.

Citation suggérée de la mosaïque MoRIC, à reprendre dans son manifeste source et dans le crédit de chaque couche qui l'utilise :

> J. Liu, X. Ren, W. Yan et al., A 76-m per pixel global color image dataset and map of Mars by Tianwen-1, Science Bulletin, https://doi.org/10.1016/j.scib.2024.04.045

Côté moteur, l'exemple cube lit déjà un `imagery.json` (`imagery=dataset`), une tuile absente donnant `undefined`, et accepte une imagerie plus profonde que le DEM (`imagerySubdivision`).

## Niveaux du cube

Les tuiles font 256 px, comme l'élévation. Sur la sphère de 3396190 m, un pixel du niveau L mesure environ 20839 / 2^L mètres. Règle proposée, celle que suit déjà l'élévation (CTX 20 m au niveau 10, HiRISE 1 m au niveau 14) : chaque source s'arrête au niveau le plus profond dont le pixel n'est pas plus fin que le sien, sans suréchantillonnage.

| Source             | Pixel source | Niveau le plus profond | Pixel du niveau |
| ------------------ | ------------ | ---------------------- | --------------- |
| HRSC global        | 2 km         | 3                      | 2,6 km          |
| Viking MDIM 2.1    | 232 m        | 6                      | 326 m           |
| Tianwen-1 MoRIC    | 76 m         | 8                      | 81 m            |
| HRSC MC13E CO5PS   | 12,5 m       | 10                     | 20 m            |
| CTX (Jezero, V01)  | 5 m          | 12                     | 5,1 m           |
| HiRIC DEM (Utopia) | 3,5 m        | 12 (élévation)         | 5,1 m           |
| HiRIC DIM (Utopia) | 0,7 m        | 14                     | 1,3 m           |
| HiRISE             | 0,25 m       | 16                     | 0,33 m          |

Ordres de grandeur : Jezero CTX au niveau 12, environ 5 300 tuiles ; HiRISE au niveau 16, environ 70 000 tuiles au plus (la mosaïque n'est pas pleine) ; Viking jusqu'au niveau 6, 32 768 tuiles au niveau 6 ; Tianwen-1 jusqu'au niveau 8, 393 216 tuiles au niveau 8.

## Étapes

### 0. Fondations

- Manifeste source de chaque produit : URL d'origine (annexes A et B du brief), SHA-256, taille, licence et crédit, projection, parallèle standard, sphère, convention de longitude, époque d'acquisition, valeur NoData. Les fichiers sources restent immuables.
- Lecteur GeoTIFF par bandes de lignes : Viking (12,7 Go) et HiRISE (7,4 Go) ne sont pas tuilés et ne tiennent pas en mémoire.
- Échantillonneur cube partagé avec `jezero-refinement.ts`, pour qu'un pixel d'imagerie et un échantillon de DEM de même direction tombent au même endroit (latitude planétocentrique, longitude est, ellipsoïde Mars 2000 du cube).
- Rééchantillonnage à bande limitée : chaque pixel de tuile moyenne la surface de source qu'il couvre, au lieu de prendre un point ; les niveaux parents se calculent depuis la source, pas depuis les enfants.

### 1. POC-1 : Jezero en CTX sur base Tianwen-1

- Base couleur Tianwen-1, niveaux 0 à 8 : d'abord le feuillet de Jezero, puis la mosaïque globale. Viking (niveaux 0 à 6) ne sert que là où Tianwen-1 n'a pas de donnée, comme repli.
- CTX 5 m sur Jezero jusqu'au niveau 12, en luminance seule, fondu dans la base sur un pixel de la source inférieure, comme la cascade d'élévation ; une tuile sans pixel CTX n'est pas écrite.
- `imagery.json` dans la révision globale, WebP 256 px, sous-arbres aussi profonds que la donnée, comme `elevation.json`.
- Vérifications de construction : bords partagés, comparaison de chaque tuile avec son parent, couverture.
- Côté moteur (`experimental/cube`) : vérifier qu'une tuile d'imagerie absente se résout par la sous-zone de l'ancêtre le plus profond, comme pour l'élévation, et le corriger sinon.
- Critère du brief : relief CTX 20 m et texture 5 m alignés, aucune couture.

### 2. POC-2 : couleur HRSC MC13E

- Télécharger CO5PS (et ND5 comme référence de luminance) depuis le serveur DLR.
- Corégistration mesurée de HRSC sur CTX par corrélation d'image multi-échelle ; le décalage mesuré et son RMSE vont au manifeste. Jamais de fusion sur les seules métadonnées CRS.
- Fusion dans un espace à luminance séparée : chrominance basse fréquence de HRSC, luminance CTX ; pas de multiplication RGB, pas de netteté artificielle.
- Évaluation sur 3 zones contrastées (delta, plancher, rempart).

### 3. POC-3 : détail HiRISE

- HiRISE 25 cm, niveaux 13 à 16, colorisé par la même chrominance, recalé sur CTX (l'alignement USGS est meilleur que 6 m au 93e centile, pas au mètre).
- Mesures : mémoire GPU, transitions de LOD, rapport imagerie niveau 16 sur DEM niveau 14 (`imagerySubdivision` 4).

### 4. POC-4 : global

- CTX V01 : téléchargement sélectif de tuiles 4° × 4°, luminance de détail là où elle est demandée, jamais l'ensemble (5,6 To).

### 5. Extensions

- HiRISE MSR 2025 (bord ouest, pack de 5,3 Go) : orthoimage pour l'imagerie, DEM 1 m pour la cascade d'élévation.
- CaSSIS + HiRISE + CRISM 2026 : couche thématique séparée, jamais présentée comme texture en vraie couleur.

### 5 bis. Utopia Planitia (Tianwen-1 HiRIC)

- Élévation, faite : le DEM HiRIC 3,5 m entre dans la cascade au-dessus de MOLA 16 ppd, niveaux 5 à 12, 7 647 tuiles, dans la révision globale `41ff3b32bce19c1eb4aa`. Ses hauteurs sont au-dessus de l'aréoïde MOLA (écart médian 0,09 m face à MOLA 128 ppd). La cascade est décrite par région dans `tools/mars/regional-refinement.ts`.
- Imagerie : l'orthoimage HiRIC 0,7 m jusqu'au niveau 14, en luminance, colorisée par la chrominance MoRIC, recalée sur MoRIC et sur l'ombrage du DEM HiRIC.
- Le DEM s'étend 100 km au nord de l'orthoimage : au-dessus de Zhurong, la texture reste MoRIC.

### 6. Publication

- `publish-generated-cube.ts` publie `imagery.json` et ses tuiles avec la révision globale ; crédits et licences dans le descripteur et `source.json`.
- Validation du brief : Mars globale sans trou, Jezero sans couture, delta sans halo, faces et pôles sans fissure, conformité des attributions.

## Décisions à prendre

1. **Double ombrage.** Les orthoimages CTX et HiRISE contiennent l'ombrage du soleil de la prise de vue, que le rendu Babylon ajoute une seconde fois. Choisir : imagerie telle quelle, ou luminance dont on retire l'ombrage calculé depuis le DEM et l'éclairage de la prise de vue (plus juste, plus long).
2. **Droits.** Le bucket R2 est public. Tianwen-1 (copyright NAOC/GRAS, citation de Liu et al. 2024 et du DOI demandée), HRSC (DLR), CTX V01 (Murray Lab) et CaSSIS ont des conditions à valider avant redistribution ; Viking, CTX et HiRISE USGS sont du domaine public américain.
3. **Métadonnées par tuile.** Le brief les demande par tuile. Proposition : les champs propres à une source (projection, datum, licence, version, méthode radiométrique, RMSE de recalage) dans le descripteur et `source.json` ; par tuile, dans le manifeste, seulement ce qui varie d'une tuile à l'autre (couverture, sources utilisées, confiance).
4. **Règle de niveau.** Le niveau le plus profond non suréchantillonné (tableau ci-dessus), ou un niveau de plus pour ne rien perdre de Viking et HRSC.
