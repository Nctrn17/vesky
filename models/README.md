# Modèle de détection : YuNet_n réentraîné pour la nuit (licence BSD-3)

Base : YuNet_n de [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) (Shiqi Yu, BSD-3,
`LICENSE-yunet.txt`), même famille et mêmes sorties que le YuNet d'OpenCV.

`yunet.onnx` part des poids publiés (`weights/yunet_n.pth`) et a été réentraîné 40 passes sur WIDER FACE
(photos de jour) et DARK FACE (photos de nuit). Recette complète : `entrainement/entrainer-nuit.sh`, après
`entrainement/prepare-darkface.py`. 1 000 photos de DARK FACE (`entrainement/darkface-split.json`) n'ont jamais servi à
l'entraînement et servent à la mesure.

Mesuré avec la règle du site (`entrainement/eval-faces.py`), contre l'ancien modèle (YuNet 2023mar d'OpenCV Zoo) :

| | Visages ratés de nuit (1 287) | Visages ratés de jour (14 954) | Grands masques sans visage, jour |
|---|---|---|---|
| Ancien modèle | 185 | 1 016 | 326 |
| Celui-ci | 64 | 938 | 332 |

Le décodage des sorties (dans `detector.js`) suit `modules/objdetect/src/face_detect.cpp` d'OpenCV.

# Second modèle : CenterFace (licence MIT)

`centerface.onnx` est le modèle [CenterFace](https://github.com/Star-Clouds/CenterFace) (`LICENSE-centerface.txt`), dans
la version publiée par [deface](https://github.com/ORB-HD/deface). Les poids sont ceux d'origine ; le fichier est
seulement converti pour accepter une image de n'importe quelle taille (dimensions d'entrée et de sortie rendues libres
avec `onnx.tools.update_model_dims`, poids retirés des entrées du graphe), comme deface le fait lui-même au chargement.
`test/verifier-tiers.sh` contrôle l'empreinte du fichier d'origine et celle du fichier converti.

Il regarde l'image réduite à 640 pixels de plus grand côté et trouve les visages moyens et grands ; YuNet ne garde que
les tout petits (moins de 4,5 % du petit côté de l'image). Le décodage de ses sorties (dans `detector.js`) suit
`deface/centerface.py`. Mesures : `entrainement/eval-reel.mjs` (vidéos) et `entrainement/eval-centerface.py` (photos).
