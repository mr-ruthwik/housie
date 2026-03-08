/* ================= GLOBAL ================= */
let peer;
let conn;
let connections = [];

let myName = "";
let ticketCount = 1;
let isHost = false;

let members = [];
let calledNumbers = [];
let selectedClaim = null;

const TICKET_PRICE = 10;

const ticketsContainer = document.getElementById("tickets-container");
const popup = document.getElementById("ticket-popup");
const ticketOptions = document.getElementById("ticket-options");
const popupClose = document.getElementById("popup-close");
const leavePopup = document.getElementById("leave-popup");
const leaveCancel = document.getElementById("leave-cancel");
const leaveConfirm = document.getElementById("leave-confirm");
const winScreen = document.getElementById("win-screen");

/* ================= HELPERS ================= */

function capitalizeName(name) {
    return name.split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function showNotification(msg) {
    const toast = document.createElement("div");
    toast.className = "card";
    toast.style.position = "fixed";
    toast.style.top = "20px";
    toast.style.left = "50%";
    toast.style.transform = "translateX(-50%)";
    toast.style.zIndex = "6000";
    toast.style.background = "var(--primary)";
    toast.style.padding = "12px 24px";
    toast.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
    toast.style.border = "1px solid rgba(255,255,255,0.2)";
    toast.style.fontWeight = "600";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "0.5s";
        setTimeout(() => toast.remove(), 500);
    }, 2500);
}

/* ================= VIEW SWITCH ================= */
function showView(id) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById("screen-" + id).classList.add("active");
}

/* ================= AUTH ================= */
document.getElementById("btn-enter").onclick = () => {
    let rawName = document.getElementById("username").value.trim();
    const tickets = Number(document.getElementById("ticket-count").value);

    if (!rawName) { showNotification("Please enter your name"); return; }
    if (tickets < 1 || tickets > 4) { showNotification("Tickets must be 1 to 4"); return; }

    myName = capitalizeName(rawName);
    ticketCount = tickets;
    showView("lobby");
};

/* ================= ROOM ACTIONS ================= */
document.getElementById("btn-create").onclick = () => {
    isHost = true;
    const roomId = Math.floor(1000 + Math.random() * 9000).toString();
    initHost(roomId);
};

document.getElementById("btn-join").onclick = () => {
    const roomId = document.getElementById("join-id").value.trim();
    if (!roomId) { showNotification("Enter Room Code"); return; }
    joinRoom(roomId);
};

/* ================= HOST LOGIC ================= */
function initHost(roomId) {
    peer = new Peer(roomId);

    peer.on("open", id => {
        members.push({ name: myName, isHost: true, tickets: ticketCount });
        document.getElementById("display-room-id").textContent = id;

        toggleHostUI(true);
        showView("arena");
        renderMembers();
        generateTickets(ticketCount);
    });

    peer.on("connection", c => {
        c.on("data", data => {
            if (data.type === "join") {
                if (calledNumbers.length > 0) {
                    c.send({ type: "game-in-progress" });
                    setTimeout(() => c.close(), 500);
                    return;
                }

                connections.push(c);
                members.push({ name: capitalizeName(data.name), isHost: false, tickets: data.tickets });

                c.send({
                    type: "sync",
                    members,
                    called: calledNumbers,
                    roomId: roomId
                });

                broadcast({ type: "members", members });
                renderMembers();
            }
            handleData(data);
        });
    });
}

/* ================= JOINER LOGIC ================= */
function joinRoom(roomId) {
    peer = new Peer();
    peer.on("open", () => {
        conn = peer.connect(roomId);
        conn.on("open", () => {
            conn.send({ type: "join", name: myName, tickets: ticketCount });
        });
        conn.on("data", handleData);
    });
}

function toggleHostUI(show) {
    const hostSections = [
        document.querySelector(".game-controls"),
        document.querySelector(".called-preview"),
        document.querySelector(".called-history")
    ];
    hostSections.forEach(el => {
        if (el) el.style.display = show ? "block" : "none";
    });
}

/* ================= HANDLE DATA ================= */
function handleData(data) {
    switch (data.type) {
        case "game-in-progress":
            showGameInProgressPopup();
            break;

        case "members":
            members = data.members;
            renderMembers();
            break;

        case "sync":
            members = data.members;
            calledNumbers = data.called || [];
            if (data.roomId) document.getElementById("display-room-id").textContent = data.roomId;

            showView("arena");
            toggleHostUI(false);
            renderMembers();
            generateTickets(ticketCount);
            break;

        case "draw":
            calledNumbers.push(data.num);
            if (isHost) {
                document.getElementById("current-number").textContent = data.num;
                updateCalledBoard();
                updateHistory();
            } else {
                showNotification(`New Number Drawn: ${data.num}`);
            }
            break;
    }
}

function showGameInProgressPopup() {
    const overlay = document.createElement("div");
    overlay.className = "popup-overlay active";
    overlay.style.zIndex = "9999";

    overlay.innerHTML = `
        <div class="popup-box" style="width: 320px; text-align: center;">
            <h3 style="color: var(--danger); margin-bottom: 15px;">Game is in Progress</h3>
            <p style="font-size: 14px; margin: 0;">Please wait until the game finishes</p>
            <p style="font-size: 14px; margin: 0;">or</p>
            <p style="font-size: 14px; margin: 0;">host a new room</p>
            <div style="margin: 15px 0;"></div>
            <p style="font-size: 13px;">Redirecting to home in <span id="timer-sec">6</span>s...</p>
        </div>
    `;
    document.body.appendChild(overlay);

    let seconds = 6;
    const interval = setInterval(() => {
        seconds--;
        if (document.getElementById("timer-sec")) document.getElementById("timer-sec").textContent = seconds;
        if (seconds <= 0) {
            clearInterval(interval);
            location.reload();
        }
    }, 1000);
}

/* ================= UI RENDERING ================= */
function renderMembers() {
    const container = document.getElementById("members-list-container");
    container.innerHTML = "";
    let totalTickets = 0;

    members.forEach((m, i) => {
        totalTickets += m.tickets;
        const div = document.createElement("div");
        div.className = "member-item";
        const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
        div.style.borderLeft = `4px solid ${colors[i % colors.length]}`;
        div.innerHTML = `
            <div class="member-info">
                <span class="member-name">${i + 1}. ${m.name}</span>
                ${m.isHost ? '<span class="member-host">HOST</span>' : ''}
                <div style="font-size: 10px; opacity: 0.6;">Tickets: ${m.tickets}</div>
            </div>
            <span class="member-price">₹ ${m.tickets * TICKET_PRICE}</span>
        `;
        container.appendChild(div);
    });

    document.getElementById("total-members").textContent = members.length;
    document.getElementById("total-price").textContent = totalTickets * TICKET_PRICE;
}

function broadcast(data) {
    connections.forEach(c => { if (c.open) c.send(data); });
}

/* ================= GAMEPLAY ACTIONS ================= */
document.getElementById("btn-draw").onclick = () => {
    if (!isHost) return;
    if (calledNumbers.length >= 90) { showNotification("All numbers drawn!"); return; }
    let n;
    do { n = Math.floor(Math.random() * 90) + 1; } while (calledNumbers.includes(n));
    calledNumbers.push(n);
    document.getElementById("current-number").textContent = n;
    updateCalledBoard();
    updateHistory();
    broadcast({ type: "draw", num: n });
};

function updateCalledBoard() {
    const grid = document.getElementById("called-grid");
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 1; i <= 90; i++) {
        const d = document.createElement("div");
        d.className = "mini-cell" + (calledNumbers.includes(i) ? " called" : "");
        d.textContent = i;
        grid.appendChild(d);
    }
}

function updateHistory() {
    const container = document.getElementById("called-history-list");
    if (!container) return;
    container.innerHTML = "";
    [...calledNumbers].reverse().slice(0, 10).forEach(n => {
        const d = document.createElement("div");
        d.className = "called-num";
        d.textContent = n;
        container.appendChild(d);
    });
}

/* ================= TICKET GENERATION ================= */
function generateTickets(count) {
    ticketsContainer.innerHTML = "";
    ticketsContainer.dataset.count = count;
    for (let i = 1; i <= count; i++) {
        const ticketData = generateTambolaTicket();
        const card = document.createElement("div");
        card.className = "ticket-card";
        card.dataset.ticket = i;
        card.innerHTML = buildTicketHTML(ticketData, i);
        ticketsContainer.appendChild(card);
    }
    enableCellClicks();
}

function buildTicketHTML(rows, index) {
    let html = `<div class="ticket-title">Ticket ${index}</div><div class="ticket-grid">`;
    rows.forEach((row, rIdx) => {
        html += `<div class="ticket-row" data-row="${rIdx}">`;
        row.forEach(num => {
            html += num ? `<div class="cell number-cell">${num}</div>` : `<div class="cell empty"></div>`;
        });
        html += `</div>`;
    });
    return html + `</div>`;
}

function enableCellClicks() {
    document.querySelectorAll(".number-cell").forEach(cell => {
        cell.onclick = () => cell.classList.toggle("active");
    });
}

/* ================= CLAIM HANDLING ================= */
document.querySelectorAll(".claim-btn").forEach(btn => {
    btn.onclick = () => {
        selectedClaim = btn.dataset.claim;
        if (ticketCount === 1) { markClaim(1); } else { openTicketPopup(); }
    };
});

function openTicketPopup() {
    popup.classList.add("active");
    ticketOptions.innerHTML = "";
    const title = document.createElement("p");
    title.style.fontSize = "13px";
    title.style.marginBottom = "12px";
    title.style.opacity = "0.8";
    title.textContent = `Select Ticket for ${selectedClaim.toUpperCase()}:`;
    ticketOptions.appendChild(title);

    for (let i = 1; i <= ticketCount; i++) {
        const b = document.createElement("button");
        b.className = "btn-outline";
        b.style.marginBottom = "8px";
        b.style.width = "100%";
        b.textContent = "Ticket " + i;
        b.onclick = () => {
            popup.classList.remove("active");
            markClaim(i);
        };
        ticketOptions.appendChild(b);
    }
}

popupClose.onclick = () => popup.classList.remove("active");

function markClaim(ticketIndex) {
    const ticket = document.querySelector(`[data-ticket="${ticketIndex}"]`);
    const activeInTicket = Array.from(ticket.querySelectorAll(".number-cell.active"));

    if (activeInTicket.length === 0) {
        showNotification("Mark numbers first!");
        return;
    }

    if (selectedClaim === "jaldi") {
        if (activeInTicket.length < 5) {
            showNotification("Need 5 numbers!");
            return;
        }
        activeInTicket.forEach(cell => cell.classList.add("claimed", "strike"));
        showNotification("Jaldi 5 Claimed!");
    }
    else if (selectedClaim.startsWith("line")) {
        const lineIdx = parseInt(selectedClaim.replace("line", "")) - 1;
        const targetRow = ticket.querySelector(`.ticket-row[data-row="${lineIdx}"]`);
        const numberCellsInRow = targetRow.querySelectorAll(".number-cell");
        const markedCellsInRow = targetRow.querySelectorAll(".number-cell.active");

        if (markedCellsInRow.length === numberCellsInRow.length && numberCellsInRow.length > 0) {
            markedCellsInRow.forEach(cell => cell.classList.add("claimed"));
            targetRow.classList.add("line-strike");
            showNotification(`Line ${lineIdx + 1} Claimed!`);
        } else {
            showNotification(`Line ${lineIdx + 1} incomplete!`);
        }
    }
    else if (selectedClaim === "housie") {
        const allNumberCells = ticket.querySelectorAll(".number-cell");
        if (activeInTicket.length === allNumberCells.length) {
            activeInTicket.forEach(cell => cell.classList.add("claimed"));
            showWinScreen();
        } else {
            showNotification("Ticket not full!");
        }
    }
}

/* ================= WIN & LEAVE ================= */
function showWinScreen() {
    winScreen.classList.add("active");
    createConfetti();
}

function createConfetti() {
    const container = document.querySelector(".confetti-container");
    container.innerHTML = "";
    for (let i = 0; i < 150; i++) {
        const c = document.createElement("div");
        c.className = "confetti";
        c.style.left = Math.random() * 100 + "%";
        c.style.top = Math.random() * 100 + "%";
        c.style.backgroundColor = ["#6366f1", "#10b981", "#f59e0b", "#ef4444"][Math.floor(Math.random() * 4)];
        c.style.animationDuration = (Math.random() * 2 + 2.5) + "s";
        container.appendChild(c);
    }
}

document.getElementById("win-home").onclick = () => location.reload();
document.getElementById("btn-leave").onclick = () => leavePopup.classList.add("active");
leaveCancel.onclick = () => leavePopup.classList.remove("active");
leaveConfirm.onclick = () => location.reload();

/* ================= TAMBOLA GENERATOR ================= */
function generateTambolaTicket() {
    let ticket = Array.from({ length: 3 }, () => Array(9).fill(null));
    let ranges = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
    let positions = [];
    while (positions.length < 15) {
        let r = Math.floor(Math.random() * 3);
        let c = Math.floor(Math.random() * 9);
        if (!positions.some(p => p.r === r && p.c === c)) positions.push({ r, c });
    }
    for (let r = 0; r < 3; r++) {
        let row = positions.filter(p => p.r === r);
        while (row.length > 5) positions.splice(positions.indexOf(row.pop()), 1);
        while (row.length < 5) {
            let c = Math.floor(Math.random() * 9);
            if (!positions.some(p => p.r === r && p.c === c)) {
                let newPos = { r, c };
                positions.push(newPos);
                row.push(newPos);
            }
        }
    }
    for (let c = 0; c < 9; c++) {
        let colCells = positions.filter(p => p.c === c);
        if (colCells.length) {
            let [min, max] = ranges[c];
            let nums = [];
            for (let i = min; i <= max; i++) nums.push(i);
            nums.sort(() => Math.random() - .5);
            colCells.sort((a, b) => a.r - b.r).forEach((p, i) => {
                ticket[p.r][p.c] = nums[i];
            });
        }
    }
    return ticket;
}