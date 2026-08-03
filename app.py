from datetime import datetime
import os
from flask import Flask, render_template, request, jsonify
import torch
import numpy as np
from PIL import Image

from predict import predict_digit

app = Flask(__name__)

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/predict-page")
def predict_page():
    return render_template("predict.html")


@app.route("/predict", methods=["POST"])
def predict():

    data = request.json

    image = np.array(data["image"], dtype=np.float32)

    digit, confidence, probs = predict_digit(image)

    return jsonify({
        "prediction": int(digit),
        "confidence": float(confidence),
        "probabilities": probs.tolist()
    })

@app.route("/health")
def health():
    return {
        "success": True,
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat()
    }
    
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
