const canvas = document.getElementById("draw-canvas");
const ctx = canvas.getContext("2d");

const clearBtn = document.getElementById("clear-btn");

const bigDigit = document.getElementById("big-digit");
const confText = document.getElementById("conf-text");

const digitList = document.getElementById("digit-list");

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

let drawing = false;

canvas.width = 280;
canvas.height = 280;

// -----------------------------------
// Build prediction rows
// -----------------------------------

for (let i = 0; i < 10; i++) {

    const row = document.createElement("div");
    row.className = "digit-row";

    row.innerHTML = `
        <div class="idx">${i}</div>

        <div class="liquid-circle">
            <div class="digit-label">${i}</div>
            <div class="liquid-fill"></div>
            <div class="liquid-fill secondary"></div>
        </div>

        <div class="bar-track">
            <div class="bar-fill"></div>
        </div>

        <div class="pct">0%</div>
    `;

    digitList.appendChild(row);

}

const rows = document.querySelectorAll(".digit-row");

// -----------------------------------
// Canvas
// -----------------------------------

ctx.fillStyle = "black";
ctx.fillRect(0, 0, canvas.width, canvas.height);

ctx.lineCap = "round";
ctx.lineJoin = "round";
ctx.strokeStyle = "white";
ctx.lineWidth = 20;

// -----------------------------------

function getPos(e) {

    const rect = canvas.getBoundingClientRect();

    if (e.touches) {

        return {

            x: e.touches[0].clientX - rect.left,
            y: e.touches[0].clientY - rect.top

        };

    }

    return {

        x: e.clientX - rect.left,
        y: e.clientY - rect.top

    };

}

// -----------------------------------

function start(e) {

    drawing = true;

    const p = getPos(e);

    ctx.beginPath();
    ctx.moveTo(p.x, p.y);

}

// -----------------------------------

function move(e) {

    if (!drawing) return;

    e.preventDefault();

    const p = getPos(e);

    ctx.lineTo(p.x, p.y);

    ctx.stroke();

    predict();

}

// -----------------------------------

function end() {

    drawing = false;

}

// -----------------------------------

canvas.addEventListener("mousedown", start);
canvas.addEventListener("mousemove", move);
window.addEventListener("mouseup", end);

canvas.addEventListener("touchstart", start);
canvas.addEventListener("touchmove", move);
canvas.addEventListener("touchend", end);

// -----------------------------------
// Clear
// -----------------------------------

clearBtn.onclick = () => {

    ctx.fillStyle = "black";
    ctx.fillRect(0,0,280,280);

    bigDigit.innerText = "-";

    confText.innerText = "Draw a digit";

    rows.forEach(r=>{

        r.classList.remove("top");

        r.querySelector(".bar-fill").style.width="0%";

        r.querySelector(".pct").innerText="0%";

        r.querySelector(".liquid-fill").style.top="100%";

        r.querySelector(".secondary").style.top="100%";

    });

}

// -----------------------------------
// Convert to 28x28
// -----------------------------------

function getImageArray(){

    const temp = document.createElement("canvas");

    temp.width = 28;
    temp.height = 28;

    const tctx = temp.getContext("2d");

    tctx.drawImage(canvas,0,0,28,28);

    const img = tctx.getImageData(0,0,28,28).data;

    const pixels = [];

    for(let i=0;i<img.length;i+=4){

        pixels.push(img[i]/255.0);

    }

    return pixels;

}

// -----------------------------------
// Prediction
// -----------------------------------

async function predict(){

    const image = getImageArray();

    statusDot.className="status-dot busy";

    statusText.innerText="Predicting...";

    try{

        const response = await fetch("/predict",{

            method:"POST",

            headers:{

                "Content-Type":"application/json"

            },

            body:JSON.stringify({

                image:image

            })

        });

        const data = await response.json();

        updatePrediction(data);

        statusDot.className="status-dot ready";

        statusText.innerText="Ready";

    }

    catch(err){

        console.error(err);

        statusText.innerText="Server Error";

    }

}

// -----------------------------------
// Update UI
// -----------------------------------

function updatePrediction(data){

    bigDigit.innerText=data.prediction;

    confText.innerText=`${data.confidence.toFixed(2)} % confidence`;

    rows.forEach((row,i)=>{

        const p=data.probabilities[i]*100;

        row.classList.remove("top");

        row.querySelector(".bar-fill").style.width=p+"%";

        row.querySelector(".pct").innerText=p.toFixed(1)+"%";

        const top=100-p;

        row.querySelector(".liquid-fill").style.top=top+"%";

        row.querySelector(".secondary").style.top=top+"%";

    });

    rows[data.prediction].classList.add("top");

}