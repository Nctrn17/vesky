# Fabrique models/centerface.onnx à partir du modèle CenterFace publié par deface
# (https://github.com/ORB-HD/deface/blob/master/deface/centerface.onnx, licence MIT) : mêmes poids, mais l'image d'entrée
# peut avoir n'importe quelle taille, alors que le fichier d'origine la fixe. Même conversion que celle du projet masque
# (https://github.com/onestlatech/masque, scripts/prepare-model.py) et que deface fait lui-même au chargement.
# Usage : python entrainement/preparer-centerface.py <centerface.onnx de deface>   (besoin : pip install onnx)
import hashlib
import os
import sys

import onnx
from onnx.tools.update_model_dims import update_inputs_outputs_dims

dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models', 'centerface.onnx')
model = onnx.load(sys.argv[1])

# Les poids listés parmi les entrées du graphe passent pour modifiables, ce qui empêche de les précalculer : on les retire
# des entrées. On retire aussi les poids qu'aucune opération n'utilise.
weights = {i.name for i in model.graph.initializer}
inputs = [i for i in model.graph.input if i.name not in weights]
del model.graph.input[:]
model.graph.input.extend(inputs)
used = {name for node in model.graph.node for name in node.input}
kept = [i for i in model.graph.initializer if i.name in used]
del model.graph.initializer[:]
model.graph.initializer.extend(kept)

model = update_inputs_outputs_dims(model, {'input.1': ['B', 3, 'H', 'W']},
                                   {'537': ['B', 1, 'h', 'w'], '538': ['B', 2, 'h', 'w'], '539': ['B', 2, 'h', 'w'], '540': ['B', 10, 'h', 'w']})
onnx.checker.check_model(model)
onnx.save(model, dst)
print(os.path.getsize(dst), 'octets, sha256', hashlib.sha256(open(dst, 'rb').read()).hexdigest())
