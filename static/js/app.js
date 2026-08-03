// ===============================
// Living Neural Network
// ===============================

const canvas = document.getElementById("net-canvas");

if (canvas) {

    const ctx = canvas.getContext("2d");

    let w, h;

    function resize() {
        w = canvas.width = canvas.offsetWidth;
        h = canvas.height = canvas.offsetHeight;
    }

    resize();
    window.addEventListener("resize", resize);

    //----------------------------------

    const NODE_COUNT = 160;
    const MAX_DISTANCE = 150;

    const nodes = [];

    for (let i = 0; i < NODE_COUNT; i++) {

        nodes.push({

            x: Math.random() * w,
            y: Math.random() * h,

            vx: (Math.random() - .5) * 0.25,
            vy: (Math.random() - .5) * 0.25,

            radius: 1.8 + Math.random() * 1.2,

            glow: 0

        });

    }

    //----------------------------------

    const edges = [];

    function buildEdges() {

        edges.length = 0;

        for (let i = 0; i < nodes.length; i++) {

            for (let j = i + 1; j < nodes.length; j++) {

                const dx = nodes[i].x - nodes[j].x;
                const dy = nodes[i].y - nodes[j].y;

                const d = Math.sqrt(dx * dx + dy * dy);

                if (d < MAX_DISTANCE) {

                    edges.push({

                        a: i,
                        b: j,
                        dist: d

                    });

                }

            }

        }

    }

    buildEdges();

    //----------------------------------

    const pulses = [];

    function fireRandomNeuron() {

        const start = Math.floor(Math.random() * nodes.length);

        nodes[start].glow = 1;

        edges.forEach(edge => {

            if (edge.a === start || edge.b === start) {

                pulses.push({

                    edge,

                    progress: 0

                });

            }

        });

    }

    setInterval(fireRandomNeuron, 350);

    //----------------------------------

    function animate() {

        ctx.clearRect(0, 0, w, h);

        //----------------------------------
        // Move Nodes
        //----------------------------------

        nodes.forEach(n => {

            n.x += n.vx;
            n.y += n.vy;

            if (n.x < 0 || n.x > w) n.vx *= -1;
            if (n.y < 0 || n.y > h) n.vy *= -1;

            n.glow *= 0.965;

        });

        //----------------------------------
        // Rebuild Connections Occasionally
        //----------------------------------

        if (Math.random() < 0.01)
            buildEdges();

        //----------------------------------
        // Draw Connections
        //----------------------------------

        edges.forEach(edge => {

            const a = nodes[edge.a];
            const b = nodes[edge.b];

            ctx.strokeStyle = "rgba(255,138,76,0.06)";
            ctx.lineWidth = 1;

            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();

        });

        //----------------------------------
        // Draw Pulses
        //----------------------------------

        for (let i = pulses.length - 1; i >= 0; i--) {

            const p = pulses[i];

            p.progress += 0.03;

            const a = nodes[p.edge.a];
            const b = nodes[p.edge.b];

            const x = a.x + (b.x - a.x) * p.progress;
            const y = a.y + (b.y - a.y) * p.progress;

            ctx.beginPath();
            ctx.arc(x, y, 2.8, 0, Math.PI * 2);

            ctx.fillStyle = "#ff8a4c";

            ctx.shadowBlur = 18;
            ctx.shadowColor = "#ff8a4c";

            ctx.fill();

            ctx.shadowBlur = 0;

            if (p.progress >= 1) {

                nodes[p.edge.b].glow = 1;

                edges.forEach(e => {

                    if (e.a === p.edge.b) {

                        if (Math.random() < 0.35) {

                            pulses.push({

                                edge: e,
                                progress: 0

                            });

                        }

                    }

                });

                pulses.splice(i, 1);

            }

        }

        //----------------------------------
        // Draw Neurons
        //----------------------------------

        nodes.forEach(n => {

            const glow = n.glow;

            ctx.beginPath();

            ctx.arc(n.x, n.y, n.radius + glow * 2.5, 0, Math.PI * 2);

            ctx.fillStyle = `rgba(255,138,76,${0.35 + glow * 0.65})`;

            ctx.shadowBlur = glow * 25;

            ctx.shadowColor = "#ff8a4c";

            ctx.fill();

            ctx.shadowBlur = 0;

        });

        requestAnimationFrame(animate);

    }

    animate();

}