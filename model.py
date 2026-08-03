import torch
import torch.nn as nn
class conv(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1=nn.Conv2d(1,32,3,1,1)
        self.conv2=nn.Conv2d(32,64,3,1,1)
        self.conv3=nn.Conv2d(64,128,3,1,1)
        self.fc1=nn.Linear(128*7*7,512)
        self.fc2=nn.Linear(512,256)
        self.fc3=nn.Linear(256,10)
        self.pool=nn.MaxPool2d(2,2)
        self.relu=nn.ReLU()
        self.batch1=nn.BatchNorm2d(32)
        self.batch2=nn.BatchNorm2d(64)
        self.batch3=nn.BatchNorm2d(128)
    def forward(self,x):
        x=self.conv1(x)
        x=self.batch1(x)
        x=self.relu(x)
        x=self.pool(x)
        x=self.conv2(x)
        x=self.batch2(x)
        x=self.relu(x)
        x=self.pool(x)
        x=self.conv3(x)
        x=self.batch3(x)
        x=self.relu(x)
        x=torch.flatten(x,1)
        x=self.fc1(x)
        x=self.relu(x)
        x=self.fc2(x)
        x=self.relu(x)
        x=self.fc3(x)
        return x
 