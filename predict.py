import torch
import numpy as np

from model import conv

device = torch.device("cpu")

model = conv()

model.load_state_dict(
    torch.load("mnist_model.pth", map_location=device)
)

model.eval()


def predict_digit(image):

    image = torch.tensor(image).reshape(1,1,28,28)

    with torch.no_grad():

        output = model(image)

        probs = torch.softmax(output,1)

        confidence, pred = torch.max(probs,1)

    return (
        pred.item(),
        confidence.item()*100,
        probs.squeeze()
    )