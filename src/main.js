// ============================================================================
// ELEVATOR INSPECTOR: BLT-NS (2013) — интерфейс и вид глазами механика.
// Камера никогда не видит сквозь стены: игрок физически находится на площадке,
// в кабине, на крыше кабины, у шкафа управления или в приямке.
// ============================================================================
import { ELEVATOR as CFG } from "./config.js";
import { ElevatorSim } from "./sim.js";

const $ = (id) => document.getElementById(id);
const sim = new ElevatorSim(CFG);
const canvas = $("view");
const ctx = canvas.getContext("2d");

// ---------- Состояние игрока ----------
let location = "landing"; // landing | cabin | roof | cabinet | pit
let playerFloor = CFG.firstFloor;
const ach = { called:false, rode:false, cabinet:false, triangle:false, roof:false, roofDrive:0, pit:false };
let rideDistanceInside = 0;
let neighbor = null, neighborTimer = 9;

// ---------- Звук (WebAudio, запускается по первому клику) ----------
let actx = null, motorOsc = null, motorGain = null, muted = false;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    motorOsc = actx.createOscillator(); motorOsc.type = "sawtooth"; motorOsc.frequency.value = 40;
    const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 170;
    motorGain = actx.createGain(); motorGain.gain.value = 0;
    motorOsc.connect(lp); lp.connect(motorGain); motorGain.connect(actx.destination);
    motorOsc.start();
  } catch { /* без звука тоже играемо */ }
}
window.addEventListener("pointerdown", initAudio, { once: false });
function tone(freq, dur = 0.08, gain = 0.035, when = 0, type = "sine") {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, actx.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + when + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(actx.currentTime + when); o.stop(actx.currentTime + when + dur + 0.02);
}
const beep = () => tone(880, 0.07, 0.03);
const ding = () => { tone(988, 0.16, 0.045); tone(1319, 0.2, 0.03, 0.12); };
const clunk = () => tone(82, 0.09, 0.07, 0, "sine");
const contactor = () => tone(180, 0.025, 0.05, 0, "square");

// ---------- Утилиты геометрии ----------
const roofAbsM = () => sim.carPosM + CFG.cabinHeightM;
const relToPlayerFloorM = () => sim.carPosM - sim.floorPosM(playerFloor);
function roofAccessibleFrom(floor) {
  const delta = roofAbsM() - sim.floorPosM(floor); // крыша чуть ниже порога — идеально
  return delta > -1.05 && delta < 0.35;
}
function landingAccessibleFromRoof() {
  for (let f = sim.minFloor; f <= sim.maxFloor; f++) if (roofAccessibleFrom(f)) return f;
  return null;
}
const carServesPlayerFloor = () =>
  sim.stopped && sim.atFloorExact(playerFloor) && sim.door > 0.7 && sim.landingDoorOpeningAt(playerFloor) > 0.7;

// ---------- COP: кнопки этажей ----------
const copBtns = new Map();
for (let f = sim.maxFloor; f >= sim.minFloor; f--) {
  const b = document.createElement("button");
  b.className = "copbtn"; b.textContent = f;
  b.addEventListener("click", () => { if (location === "cabin" && sim.registerCarCall(f)) beep(); });
  $("copButtons").appendChild(b); copBtns.set(f, b);
}

function holdButton(el, set) {
  const on = (e) => { e.preventDefault(); initAudio(); set(true); el.classList.add("held"); };
  const off = () => { set(false); el.classList.remove("held"); };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointerleave", off);
  el.addEventListener("pointercancel", off);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- Действия игрока ----------
$("actStairsDown").onclick = () => goStairs(-1);
$("actStairsUp").onclick = () => goStairs(+1);
function goStairs(d) {
  if (location !== "landing") return;
  const nf = playerFloor + d;
  if (nf < sim.minFloor || nf > sim.maxFloor) return;
  if (sim.manualLandingFloor === playerFloor && sim.manualLandingOpening > 0.05) sim.closeManualLandingDoor();
  playerFloor = nf;
  sim.log(`Ты поднялся по лестнице на этаж ${playerFloor}.`.replace("поднялся", d > 0 ? "поднялся" : "спустился"));
}
$("actTriangleOpen").onclick = () => { if (sim.openManualLandingDoor(playerFloor)) { ach.triangle = true; clunk(); } };
$("actTriangleClose").onclick = () => sim.closeManualLandingDoor();
$("actForceCarDoor").onclick = () => {
  if (sim.doorZoneFloor() === playerFloor && sim.manualLandingOpening > 0.5) sim.doorOpenCommand(true);
};
$("actEnterCabin").onclick = () => {
  if (!carServesPlayerFloor()) return;
  if (sim.manualLandingFloor === playerFloor) sim.closeManualLandingDoor();
  location = "cabin"; rideDistanceInside = 0;
  sim.log("Ты зашёл в кабину.");
};
$("actExitCabin").onclick = () => {
  const f = sim.doorZoneFloor();
  if (location !== "cabin" || f === null || sim.door <= 0.7 || !sim.stopped) return;
  playerFloor = f; location = "landing";
  sim.log(`Ты вышел на площадке этажа ${f}.`);
};
$("actToRoof").onclick = () => {
  if (!sim.stopped || sim.manualLandingFloor !== playerFloor || sim.manualLandingOpening <= 0.7) return;
  if (!roofAccessibleFrom(playerFloor)) return;
  location = "roof"; ach.roof = true; sim.closeManualLandingDoor();
  sim.log("Ты шагнул на крышу кабины. ДШ за тобой закрылась доводчиком. Пост ревизии — под рукой.", "warn");
};
$("actOffRoof").onclick = () => {
  if (!sim.stopped) return;
  const f = landingAccessibleFromRoof();
  if (f === null) return;
  sim.setRoofInspection(false);
  playerFloor = f; location = "landing";
  sim.log(`Ты открыл ДШ со стороны шахты и вышел на площадку этажа ${f}. Ревизия возвращена в НОРМУ.`);
};
$("actToCabinet").onclick = () => {
  if (playerFloor !== CFG.cabinetFloor) return;
  if (sim.manualLandingFloor === playerFloor && sim.manualLandingOpening > 0.05) sim.closeManualLandingDoor();
  location = "cabinet"; ach.cabinet = true;
  sim.log("Шкаф управления открыт ключом. Вот она, святая святых.");
};
$("actFromCabinet").onclick = () => { location = "landing"; sim.log("Шкаф управления закрыт."); };
$("actToPit").onclick = () => {
  if (playerFloor !== sim.minFloor || sim.manualLandingOpening <= 0.7 || sim.carPosM < 0.9) return;
  location = "pit"; ach.pit = true; sim.closeManualLandingDoor();
  sim.log("Ты спустился по скобам в приямок. Первое дело — кнопка СТОП!", "warn");
};
$("actFromPit").onclick = () => {
  if (!sim.stopped) return;
  playerFloor = sim.minFloor; location = "landing";
  sim.log("Ты поднялся из приямка на площадку первого этажа.");
};

// Панели
$("hallUp").onclick = () => { if (sim.registerHallCall(playerFloor, "up")) { ach.called = true; beep(); } };
$("hallDown").onclick = () => { if (sim.registerHallCall(playerFloor, "down")) { ach.called = true; beep(); } };
$("copDoorOpen").onclick = () => { if (location === "cabin") { sim.doorOpenCommand(false); beep(); } };
$("copDoorClose").onclick = () => { if (location === "cabin") { sim.doorCloseCommand(false); beep(); } };
$("copAlarm").onclick = () => {
  tone(660, 0.12, 0.05); tone(660, 0.12, 0.05, 0.2);
  const between = sim.doorZoneFloor() === null;
  sim.log(between ? "📞 Диспетчер: «Вижу остановку между этажами. Не пытайтесь выбраться сами, механик выехал!»"
                  : "📞 Диспетчер: «Связь работает, вызов принят. Что у вас случилось?»");
};
$("roofModeToggle").onclick = () => { sim.setRoofInspection(!sim.roofInspection); contactor(); };
$("roofStopToggle").onclick = () => { sim.setRoofStop(!sim.roofStop); contactor(); };
holdButton($("roofUp"), (v) => { sim.roofUpHeld = v; });
holdButton($("roofDown"), (v) => { sim.roofDownHeld = v; });
$("cabPowerToggle").onclick = () => { sim.setPower(!sim.powerOn); contactor(); };
$("cabServiceToggle").onclick = () => { sim.setCabinetService(!sim.cabinetService); contactor(); };
holdButton($("cabUp"), (v) => { sim.cabinetUpHeld = v; });
holdButton($("cabDown"), (v) => { sim.cabinetDownHeld = v; });
$("pitStopToggle").onclick = () => { sim.setPitStop(!sim.pitStop); contactor(); };
$("btnMute").onclick = () => { muted = !muted; $("btnMute").textContent = muted ? "🔇 Тихо" : "🔊 Звук"; };
$("btnReset").onclick = () => location.reload();
$("cfgLine").textContent =
  `Конфиг (пока временный): ${CFG.model}, ${CFG.year} г., ${CFG.floors} этажей × ${CFG.floorHeightM} м, ` +
  `${CFG.ratedLoadKg} кг / ${CFG.ratedPersons} чел., ${CFG.ratedSpeedMps} м/с, шкаф управления на ${CFG.cabinetFloor}-м этаже. ` +
  `Настоящие данные твоего лифта вносятся в src/config.js.`;

// ---------- Соседи (автожители подъезда) ----------
function tickNeighbours(dt) {
  if (!$("chkNeighbours").checked) return;
  if (!neighbor) {
    if (sim.effectiveMode() !== "normal" || !sim.safetyOk) return;
    neighborTimer -= dt;
    if (neighborTimer > 0) return;
    const from = sim.minFloor + Math.floor(Math.random() * CFG.floors);
    let to = sim.minFloor + Math.floor(Math.random() * CFG.floors);
    if (to === from) to = to === sim.maxFloor ? to - 1 : to + 1;
    neighbor = { from, to, stage: "wait" };
    sim.registerHallCall(from, to > from ? "up" : "down");
    return;
  }
  const at = sim.doorZoneFloor();
  if (sim.stopped && sim.door > 0.75) {
    if (neighbor.stage === "wait" && at === neighbor.from) {
      neighbor.stage = "ride";
      sim.log(`Сосед зашёл на этаже ${neighbor.from} и нажал ${neighbor.to}.`);
      sim.registerCarCall(neighbor.to);
    } else if (neighbor.stage === "ride" && at === neighbor.to) {
      sim.log(`Сосед вышел на этаже ${neighbor.to}.`);
      neighbor = null; neighborTimer = 8 + Math.random() * 16;
    }
  }
}

// ============================================================================
// РЕНДЕР ВИДА ГЛАЗАМИ ИГРОКА
// ============================================================================
function R(x, y, w, h, fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
function vGrad(x, y, w, h, c1, c2) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, c1); g.addColorStop(1, c2); ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
}
function steelDoor(x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, "#8d97a1"); g.addColorStop(0.25, "#c7cfd6"); g.addColorStop(0.55, "#99a3ac"); g.addColorStop(1, "#7d8791");
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(40,48,56,.55)"; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
function label(txt, x, y, size = 13, color = "#d7dee5", align = "center", bold = false) {
  ctx.fillStyle = color; ctx.font = `${bold ? "700 " : ""}${size}px system-ui, sans-serif`;
  ctx.textAlign = align; ctx.fillText(txt, x, y);
}
function drawFloorIndicator(cx, y, small = false) {
  const w = small ? 84 : 110, h = small ? 34 : 42;
  R(cx - w / 2, y, w, h, "#101315");
  ctx.strokeStyle = "#39424b"; ctx.strokeRect(cx - w / 2, y, w, h);
  ctx.fillStyle = sim.powerOn ? "#ff4b33" : "#3a2d2a";
  ctx.font = `700 ${small ? 22 : 28}px ui-monospace, monospace`; ctx.textAlign = "center";
  ctx.fillText(sim.powerOn ? String(sim.displayFloor()) : "–", cx - 10, y + h - 9);
  if (sim.powerOn && !sim.stopped) {
    const ax = cx + w / 2 - 20, ay = y + h / 2;
    ctx.beginPath();
    if (sim.carVelMps > 0) { ctx.moveTo(ax, ay - 9); ctx.lineTo(ax - 7, ay + 6); ctx.lineTo(ax + 7, ay + 6); }
    else { ctx.moveTo(ax, ay + 9); ctx.lineTo(ax - 7, ay - 6); ctx.lineTo(ax + 7, ay - 6); }
    ctx.fillStyle = "#ffb02e"; ctx.fill();
  }
}

// ---- Вид: этажная площадка ----
function drawLanding() {
  vGrad(0, 0, 960, 620, "#a39c92", "#6f6a62");
  ctx.strokeStyle = "rgba(60,56,50,.35)";
  for (let x = 0; x <= 960; x += 160) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 500); ctx.stroke(); }
  for (let y = 0; y <= 500; y += 125) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(960, y); ctx.stroke(); }
  vGrad(0, 500, 960, 120, "#4d4a45", "#2e2c29"); // пол площадки
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  for (let x = -80; x < 1100; x += 140) { ctx.beginPath(); ctx.moveTo(x, 500); ctx.lineTo(x - 40, 620); ctx.stroke(); }

  if (playerFloor === CFG.cabinetFloor) { // шкаф управления на стене
    vGrad(105, 165, 118, 225, "#7d858d", "#59616a");
    ctx.strokeStyle = "#2f363d"; ctx.strokeRect(105, 165, 118, 225);
    R(120, 182, 88, 26, "#20260f"); label("ШУ · BLT", 164, 200, 13, "#bfe07a", "center", true);
    label("⚠ 380 В", 164, 245, 13, "#ffd489"); label("ключ у механика", 164, 280, 10, "#cfd6dd");
  }
  // табличка этажа
  vGrad(135, 72, 74, 54, "#d8d3c8", "#b8b2a6");
  label(String(playerFloor), 172, 110, 30, "#33302a", "center", true);

  // портал ДШ
  const px = 325, py = 78, pw = 310, ph = 445;
  vGrad(px - 16, py - 14, pw + 32, ph + 16, "#565e66", "#333a41");
  ctx.save();
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const opening = sim.landingDoorOpeningAt(playerFloor);
  const rel = relToPlayerFloorM();
  if (Math.abs(rel) <= 0.26) {
    // кабина у этажа: за ДШ — двери кабины или её интерьер
    if (sim.door > 0.02) { // интерьер
      vGrad(px, py, pw, ph, sim.powerOn ? "#d9d2c2" : "#6c675c", "#9c968a");
      R(px + 60, py + 65, 190, 150, sim.powerOn ? "#bfc9cd" : "#5f6668"); // зеркало
      label(sim.powerOn ? "BLT-NS" : "", px + pw / 2, py + 300, 15, "#6b675f", "center", true);
    } else vGrad(px, py, pw, ph, "#767f88", "#59616a");
    if (sim.door < 0.99) { // створки кабины
      const dw = pw / 2;
      steelDoor(px - dw * sim.door + 6, py + 4, dw - 6, ph - 6);
      steelDoor(px + dw + dw * sim.door, py + 4, dw - 6, ph - 6);
    }
  } else {
    // кабины нет: тёмная шахта, направляющие, канаты и сама кабина где-то выше/ниже
    vGrad(px, py, pw, ph, "#05070a", "#0a0e13");
    R(px + 22, py, 9, ph, "#2b333c"); R(px + pw - 31, py, 9, ph, "#2b333c"); // направляющие
    ctx.strokeStyle = "rgba(150,165,180,.5)";
    for (const dx of [-46, -22, 2, 26]) { ctx.beginPath(); ctx.moveTo(px + pw / 2 + dx, py); ctx.lineTo(px + pw / 2 + dx, py + ph); ctx.stroke(); }
    // силуэт кабины (смещение стилизовано: видно примерно на этаж вверх/вниз)
    const carTopY = 300 - rel * 62;
    if (carTopY > -240 && carTopY < 780) {
      vGrad(px + 32, carTopY, pw - 64, 235, "#2c3742", "#161e26");
      ctx.strokeStyle = "#45525f"; ctx.strokeRect(px + 32, carTopY, pw - 64, 235);
      if (rel < 0) { // кабина ниже: видна крыша с приводом дверей
        R(px + 70, carTopY - 16, 170, 18, "#3c4854");
        label("крыша кабины", px + pw / 2, carTopY + 30, 11, "#8fb6c9");
      } else {
        label("низ кабины", px + pw / 2, carTopY + 215, 11, "#8fb6c9");
      }
      R(px + pw / 2 - 1, carTopY, 2, 235, "#0c1117");
    }
    // противовес на фоне уезжает в противоположную сторону
    const cwY = 300 + (sim.carPosM - sim.topPosM / 2) * -14;
    R(px + 245, cwY - 70, 30, 140, "rgba(70,84,98,.8)");
  }
  // створки ДШ
  if (opening < 0.999) {
    const dw = pw / 2;
    steelDoor(px - dw * opening, py, dw, ph);
    const rx = px + dw + dw * opening;
    steelDoor(rx, py, dw, ph);
    // отверстие под треугольный ключ на правой створке
    const kx = rx + 16, ky = py + 215;
    ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx - 7, ky + 12); ctx.lineTo(kx + 7, ky + 12); ctx.closePath();
    ctx.fillStyle = "#20262c"; ctx.fill();
  }
  ctx.restore();
  if (sim.manualLandingFloor === playerFloor && sim.manualLandingOpening > 0.05 && Math.abs(relToPlayerFloorM()) > 0.26) {
    // предупреждающие полосы у открытого проёма без кабины
    for (let i = 0; i < 8; i++) R(px + i * 40, py + ph - 4, 20, 8, i % 2 ? "#20262c" : "#ffb02e");
  }
  drawFloorIndicator(480, 22);

  // вызывной пост
  vGrad(682, 218, 52, 128, "#aab3bb", "#7d8791");
  ctx.strokeStyle = "#39424b"; ctx.strokeRect(682, 218, 52, 128);
  for (const [dir, cy, sym] of [["up", 252, "▲"], ["down", 312, "▼"]]) {
    const lit = sim.hallCalls.has(`${playerFloor}:${dir}`);
    ctx.beginPath(); ctx.arc(708, cy, 16, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#ffb02e" : "#4a545e"; ctx.fill(); ctx.stroke();
    label(sym, 708, cy + 5, 13, lit ? "#402e00" : "#d7dee5", "center", true);
  }
  label(`этаж ${playerFloor}`, 480, 592, 13, "#cfd6dd");
}

// ---- Вид: внутри кабины (лицом к дверям) ----
function drawCabin() {
  const shake = Math.abs(sim.carVelMps) * 1.6;
  const dx = Math.sin(sim.time * 41) * shake, dy = Math.cos(sim.time * 53) * shake * 0.6;
  ctx.save(); ctx.translate(dx, dy);
  vGrad(-10, -10, 980, 640, sim.powerOn ? "#cfc8b8" : "#5d594f", "#8f8a7d");
  // боковые стены "перспективой"
  ctx.fillStyle = sim.powerOn ? "#b9b2a1" : "#4c4941";
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(270, 70); ctx.lineTo(270, 520); ctx.lineTo(0, 620); ctx.fill();
  ctx.beginPath(); ctx.moveTo(960, 0); ctx.lineTo(690, 70); ctx.lineTo(690, 520); ctx.lineTo(960, 620); ctx.fill();
  vGrad(270, 70, 420, 48, "#e8e2cf", "#c8c1ad"); // потолок со светильником
  if (sim.powerOn) { R(415, 84, 130, 20, "#fff6d8"); }
  else { R(462, 84, 36, 16, "#ffd489"); } // аварийное освещение

  const px = 315, py = 118, pw = 330, ph = 405;
  vGrad(px - 14, py - 12, pw + 28, ph + 14, "#5b646d", "#39424b");
  ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  if (sim.door > 0.02) { // площадка за дверьми
    vGrad(px, py, pw, ph, "#a39c92", "#77726a");
    R(px, py + ph - 55, pw, 55, "#474440");
    const f = sim.doorZoneFloor();
    if (f !== null) label(`этаж ${f}`, px + pw / 2, py + 90, 24, "#454138", "center", true);
  }
  if (sim.door < 0.999) {
    const dw = pw / 2;
    steelDoor(px - dw * sim.door, py, dw, ph);
    steelDoor(px + dw + dw * sim.door, py, dw, ph);
  }
  ctx.restore();
  drawFloorIndicator(480, 66, true);

  // табличка завода
  R(295, 205, 126, 74, "#ece7da"); ctx.strokeStyle = "#7a766a"; ctx.strokeRect(295, 205, 126, 74);
  label("BLT-NS", 358, 228, 14, "#33302a", "center", true);
  label(`${CFG.ratedLoadKg} кг · ${CFG.ratedPersons} чел.`, 358, 248, 11, "#55524a");
  label(`2013 г. · ${CFG.ratedSpeedMps} м/с`, 358, 265, 11, "#55524a");

  // нарисованная панель приказа справа (живая — HTML-панель справа от вида)
  vGrad(705, 150, 105, 330, "#aab3bb", "#78828c");
  ctx.strokeStyle = "#39424b"; ctx.strokeRect(705, 150, 105, 330);
  label("BLT", 757, 176, 14, "#39424b", "center", true);
  let i = 0;
  for (let f = sim.maxFloor; f >= sim.minFloor; f--, i++) {
    const cx = 732 + (i % 2) * 50, cy = 208 + Math.floor(i / 2) * 52;
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2);
    ctx.fillStyle = sim.carCalls.has(f) ? "#ffb02e" : (sim.atFloorExact(f) ? "#79d69a" : "#525d67");
    ctx.fill(); ctx.stroke();
    label(String(f), cx, cy + 5, 13, "#10161c", "center", true);
  }
  vGrad(0, 523, 960, 97, "#575349", "#33302b"); // пол кабины
  ctx.restore();
  if (!sim.powerOn) { R(0, 0, 960, 620, "rgba(0,0,0,.42)"); label("аварийное освещение", 480, 40, 13, "#ffd489"); }
}

// ---- Вид: крыша кабины (стенка шахты перед тобой едет мимо) ----
function drawRoof() {
  vGrad(0, 0, 960, 620, "#11161c", "#080b0f");
  const eyeM = roofAbsM() + 0.12, ppm = 128, y0 = 300;
  const screenY = (worldM) => y0 + (eyeM - worldM) * ppm;
  // стенка шахты и обратные стороны ДШ каждого этажа
  for (let f = sim.minFloor; f <= sim.maxFloor; f++) {
    const sill = sim.floorPosM(f), top = sill + 2.1;
    const yTop = screenY(top), yBot = screenY(sill);
    if (yBot < -60 || yTop > 700) continue;
    vGrad(355, yTop, 250, yBot - yTop, "#39434e", "#252e37");
    ctx.strokeStyle = "#4d5a67"; ctx.strokeRect(355, yTop, 250, yBot - yTop);
    R(479, yTop, 2, yBot - yTop, "#12181f");
    R(355, yTop - 10, 250, 12, "#4d5a67"); // порог/балка
    label(`ДШ · ${f}`, 480, yTop + 26, 12, "#9fb6c6");
  }
  // панели шахты
  ctx.strokeStyle = "rgba(90,110,130,.25)";
  for (let m = 0; m <= sim.topPosM + 4; m += 1.4) {
    const y = screenY(m);
    if (y > -20 && y < 640) { ctx.beginPath(); ctx.moveTo(90, y); ctx.lineTo(870, y); ctx.stroke(); }
  }
  // направляющие кабины по бокам
  vGrad(96, 0, 16, 620, "#46545f", "#242e37"); vGrad(848, 0, 16, 620, "#46545f", "#242e37");
  // подвесные канаты вверх
  ctx.strokeStyle = "rgba(170,185,200,.75)"; ctx.lineWidth = 2;
  for (const dx of [-70, -35, 0, 35, 70]) { ctx.beginPath(); ctx.moveTo(480 + dx, 0); ctx.lineTo(480 + dx * 0.7, 492); ctx.stroke(); }
  ctx.lineWidth = 1;
  // подвесной кабель дугой
  ctx.strokeStyle = "#1e262e"; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(830, 0); ctx.quadraticCurveTo(770, 310, 700, 500); ctx.stroke(); ctx.lineWidth = 1;
  // перекрытие шахты, когда подъезжаем кверху
  const ceilY = screenY(sim.topPosM + CFG.cabinHeightM + 2.6);
  if (ceilY > -40) { vGrad(60, ceilY - 46, 840, 48, "#3c4753", "#202932"); label("перекрытие шахты", 480, ceilY - 16, 12, "#c7d3de"); }
  // крыша кабины под ногами + привод дверей
  vGrad(70, 490, 820, 130, "#59636d", "#333c45");
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  for (let x = 70; x < 900; x += 55) { ctx.beginPath(); ctx.moveTo(x, 490); ctx.lineTo(x - 18, 620); ctx.stroke(); }
  vGrad(360, 512, 240, 58, "#707a84", "#49525b"); label("привод дверей", 480, 548, 12, "#1d242c", "center", true);
  // пост ревизии в углу
  vGrad(762, 400, 92, 110, "#c7a23a", "#9c7d24");
  ctx.strokeStyle = "#4f3f10"; ctx.strokeRect(762, 400, 92, 110);
  ctx.beginPath(); ctx.arc(808, 436, 15, 0, Math.PI * 2);
  ctx.fillStyle = sim.roofStop ? "#ff3b30" : "#8f2c26"; ctx.fill(); ctx.stroke();
  label("СТОП", 808, 468, 10, "#2e2405", "center", true);
  label(sim.roofInspection ? "РЕВИЗИЯ" : "НОРМА", 808, 494, 11, sim.roofInspection ? "#5d1500" : "#2e2405", "center", true);
  if (!sim.stopped) label(`${Math.abs(sim.carVelMps).toFixed(2)} м/с — шахта идёт мимо`, 480, 36, 14, "#ffd489", "center", true);
}

// ---- Вид: шкаф управления ----
function drawCabinet() {
  vGrad(0, 0, 960, 620, "#8a857b", "#5d594f");
  vGrad(0, 520, 960, 100, "#45423d", "#2e2c28");
  vGrad(250, 36, 460, 548, "#78818a", "#4e575f");
  ctx.strokeStyle = "#272e35"; ctx.lineWidth = 3; ctx.strokeRect(250, 36, 460, 548); ctx.lineWidth = 1;
  vGrad(275, 60, 410, 500, "#d3d8dc", "#aeb6bb");
  // дисплей станции
  R(400, 80, 205, 86, sim.powerOn ? "#122b1c" : "#0c100e");
  ctx.strokeStyle = "#39424b"; ctx.strokeRect(400, 80, 205, 86);
  if (sim.powerOn) {
    ctx.fillStyle = "#75f0a0"; ctx.font = "700 30px ui-monospace, monospace"; ctx.textAlign = "left";
    ctx.fillText(`${sim.displayFloor()}`, 418, 116);
    ctx.font = "12px ui-monospace, monospace";
    const mode = sim.effectiveMode() === "normal" ? "NOR" : sim.effectiveMode() === "inspection" ? "INS" : "OFF";
    ctx.fillText(`${mode}  ${sim.carVelMps >= 0 ? "+" : ""}${sim.carVelMps.toFixed(2)} m/s`, 418, 140);
    ctx.fillText(sim.safetyOk ? "SAFETY OK" : "SAFETY OPEN", 418, 157);
  }
  // платы и контакторы
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    const x = 305 + c * 95, y = 205 + r * 82;
    R(x, y, 72, 56, r === 0 ? "#26406b" : "#39424b");
    ctx.beginPath(); ctx.arc(x + 12, y + 12, 4, 0, Math.PI * 2);
    ctx.fillStyle = sim.powerOn ? (r === 1 && !sim.stopped ? "#ffb02e" : "#42c77a") : "#243028"; ctx.fill();
  }
  // радиатор частотника
  for (let x = 305; x < 480; x += 12) R(x, 465, 5, 70, "#6b757f");
  label("привод", 390, 552, 11, "#39424b");
  // главный выключатель
  R(560, 450, 86, 92, "#2e353d");
  ctx.save(); ctx.translate(603, 496); ctx.rotate(sim.powerOn ? -0.6 : 0.6);
  R(-7, -34, 14, 42, sim.powerOn ? "#ff5c5c" : "#8a4b4b"); ctx.restore();
  label("ГЛАВНЫЙ", 603, 560, 11, "#39424b", "center", true);
  label("СТАНЦИЯ УПРАВЛЕНИЯ · BLT-NS", 480, 24, 14, "#f0e9d8", "center", true);
  R(292, 78, 82, 52, "#f4d03f"); label("⚡ 380В", 333, 110, 14, "#43370a", "center", true);
}

// ---- Вид: приямок ----
function drawPit() {
  vGrad(0, 0, 960, 620, "#151a1f", "#0a0d10");
  vGrad(110, 0, 14, 620, "#46545f", "#232c34"); vGrad(836, 0, 14, 620, "#46545f", "#232c34");
  // низ кабины над головой
  const carY = Math.max(40, 430 - sim.carPosM * 62);
  vGrad(250, carY - 95, 460, 95, "#2c3742", "#171f28");
  R(250, carY - 8, 460, 10, "#46545f"); label("низ кабины", 480, carY - 45, 12, "#8fb6c9");
  // пол приямка и буфера
  vGrad(0, 535, 960, 85, "#3b403f", "#232726");
  for (const bx of [355, 580]) {
    vGrad(bx, 448, 52, 88, "#b08a2e", "#6d5416");
    for (let y = 458; y < 530; y += 12) R(bx, y, 52, 4, "#4d3b0d");
    label("буфер", bx + 26, 556, 10, "#ffd489");
  }
  // натяжное устройство ОС
  ctx.beginPath(); ctx.arc(175, 455, 42, 0, Math.PI * 2);
  ctx.fillStyle = "#39434e"; ctx.fill(); ctx.strokeStyle = "#5b6a78"; ctx.stroke();
  ctx.beginPath(); ctx.arc(175, 455, 12, 0, Math.PI * 2); ctx.fillStyle = "#161d24"; ctx.fill();
  label("натяжное ОС", 175, 520, 11, "#9fb6c6");
  // скобы-лестница
  ctx.strokeStyle = "#7d8a96"; ctx.lineWidth = 5;
  for (let y = 150; y < 530; y += 52) { ctx.beginPath(); ctx.moveTo(755, y); ctx.lineTo(800, y); ctx.stroke(); }
  ctx.lineWidth = 1;
  // СТОП приямка
  vGrad(66, 280, 70, 86, "#c7a23a", "#9c7d24");
  ctx.beginPath(); ctx.arc(101, 312, 13, 0, Math.PI * 2);
  ctx.fillStyle = sim.pitStop ? "#ff3b30" : "#8f2c26"; ctx.fill();
  label("СТОП", 101, 346, 10, "#2e2405", "center", true);
  label("приямок", 480, 36, 14, "#cfd6dd", "center", true);
}

function draw() {
  ctx.clearRect(0, 0, 960, 620);
  if (location === "landing") drawLanding();
  else if (location === "cabin") drawCabin();
  else if (location === "roof") drawRoof();
  else if (location === "cabinet") drawCabinet();
  else drawPit();
}

// ---------- Обновление интерфейса ----------
const tasksDef = [
  ["called", "Вызвать лифт с этажной площадки"],
  ["rode", "Проехать в кабине хотя бы на один этаж"],
  ["cabinet", "Добраться до шкафа управления и открыть его"],
  ["triangle", "Открыть двери шахты треугольным ключом"],
  ["roof", "Выйти на крышу кабины (кабина этажом ниже + треугольник)"],
  ["roofDriveDone", "Проехать на крыше в ревизии один этаж"],
  ["pit", "Спуститься в приямок (1-й этаж, треугольник, кабина выше)"],
];
let lastTaskSig = "", lastLogCount = -1, seenEvents = 0;

function setBtn(el, visible, enabled = true) {
  el.style.display = visible ? "" : "none";
  el.disabled = !enabled;
}
function fmtTime(t) {
  const m = String(Math.floor(t / 60)).padStart(2, "0"), s = String(Math.floor(t % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

function updateUI() {
  const mode = sim.effectiveMode();
  // шапка
  $("badgeMode").textContent = mode === "normal" ? "НОРМАЛЬНАЯ РАБОТА" : mode === "inspection" ? "РЕВИЗИЯ / СЕРВИС" : "БЕЗ ПИТАНИЯ";
  $("badgeMode").className = "badge" + (mode === "normal" ? " ok" : mode === "off" ? " bad" : "");
  const reasons = sim.safetyReasons();
  $("badgeSafety").textContent = reasons.length ? "ЦЕПЬ БЕЗ. РАЗОМКНУТА" : "ЦЕПЬ БЕЗ. ЦЕЛА";
  $("badgeSafety").className = "badge" + (reasons.length ? " bad" : " ok");
  $("badgePower").textContent = sim.powerOn ? "ПИТАНИЕ ЕСТЬ" : "ПИТАНИЯ НЕТ";
  $("badgePower").className = "badge" + (sim.powerOn ? " ok" : " bad");
  const arrow = sim.stopped ? "" : sim.carVelMps > 0 ? " ▲" : " ▼";
  $("badgeFloor").textContent = `КАБИНА: ЭТАЖ ${sim.displayFloor()}${arrow}`;

  // где мы
  const locText = {
    landing: [`Площадка ${playerFloor}-го этажа`, landingDesc()],
    cabin: ["В кабине", cabinDesc()],
    roof: ["На крыше кабины", roofDesc()],
    cabinet: [`Шкаф управления (${CFG.cabinetFloor}-й этаж)`, "Главный выключатель, сервисный режим и дисплей станции. В сервисе кабина ездит только от кнопок ниже."],
    pit: ["В приямке", sim.pitStop ? "СТОП нажат — привод заблокирован, можно осматриваться." : "⚠ СТОП приямка ещё не нажат! В реальном мире так делать нельзя."],
  }[location];
  $("locTitle").textContent = locText[0];
  $("locDesc").textContent = locText[1];

  // действия
  const L = location === "landing";
  setBtn($("actStairsDown"), L, playerFloor > sim.minFloor);
  setBtn($("actStairsUp"), L, playerFloor < sim.maxFloor);
  const manualHere = sim.manualLandingFloor === playerFloor;
  setBtn($("actTriangleOpen"), L && !manualHere, sim.manualLandingFloor === null);
  setBtn($("actTriangleClose"), L && manualHere && sim.manualLandingTarget === 1);
  setBtn($("actForceCarDoor"), L && manualHere && sim.doorZoneFloor() === playerFloor, sim.manualLandingOpening > 0.5 && sim.door < 0.9);
  setBtn($("actEnterCabin"), L, carServesPlayerFloor());
  setBtn($("actExitCabin"), location === "cabin", sim.stopped && sim.door > 0.7 && sim.doorZoneFloor() !== null);
  setBtn($("actToRoof"), L, sim.stopped && manualHere && sim.manualLandingOpening > 0.7 && roofAccessibleFrom(playerFloor));
  setBtn($("actOffRoof"), location === "roof", sim.stopped && landingAccessibleFromRoof() !== null);
  setBtn($("actToCabinet"), L && playerFloor === CFG.cabinetFloor);
  setBtn($("actFromCabinet"), location === "cabinet");
  setBtn($("actToPit"), L && playerFloor === sim.minFloor, manualHere && sim.manualLandingOpening > 0.7 && sim.carPosM > 0.9);
  setBtn($("actFromPit"), location === "pit", sim.stopped);

  // панели по месту
  $("panelLanding").style.display = L ? "" : "none";
  $("panelCabin").style.display = location === "cabin" ? "" : "none";
  $("panelRoof").style.display = location === "roof" ? "" : "none";
  $("panelCabinet").style.display = location === "cabinet" ? "" : "none";
  $("panelPit").style.display = location === "pit" ? "" : "none";
  $("hallUp").disabled = playerFloor === sim.maxFloor;
  $("hallDown").disabled = playerFloor === sim.minFloor;
  $("hallUp").classList.toggle("lit", sim.hallCalls.has(`${playerFloor}:up`));
  $("hallDown").classList.toggle("lit", sim.hallCalls.has(`${playerFloor}:down`));
  $("landingHint").textContent = landingHint();
  for (const [f, b] of copBtns) b.classList.toggle("lit", sim.carCalls.has(f));

  // крыша
  $("roofModeToggle").textContent = `Переключатель: ${sim.roofInspection ? "РЕВИЗИЯ" : "НОРМА"}`;
  $("roofModeToggle").classList.toggle("on", sim.roofInspection);
  $("roofStopToggle").textContent = sim.roofStop ? "СТОП НАЖАТА" : "СТОП отжата";
  $("roofStopToggle").classList.toggle("on", sim.roofStop);
  $("roofHint").textContent = roofHint();
  // шкаф
  $("cabPowerToggle").textContent = `Главный выкл.: ${sim.powerOn ? "ВКЛ" : "ВЫКЛ"}`;
  $("cabPowerToggle").classList.toggle("on", !sim.powerOn);
  $("cabServiceToggle").textContent = `Сервис: ${sim.cabinetService ? "ВКЛ" : "ВЫКЛ"}`;
  $("cabServiceToggle").classList.toggle("on", sim.cabinetService);
  $("cabinetDisplay").className = "display" + (sim.powerOn ? "" : " off");
  $("cabinetDisplay").textContent = sim.powerOn
    ? `${CFG.model}  этаж: ${sim.displayFloor()}\n` +
      `режим: ${mode === "normal" ? "НОРМАЛЬНАЯ" : "РЕВИЗИЯ/СЕРВИС"}\n` +
      `скорость: ${sim.carVelMps.toFixed(2)} м/с   двери: ${doorWord()}\n` +
      `цепь без.: ${reasons.length ? "РАЗОМКНУТА — " + reasons.join("; ") : "OK"}\n` +
      `задание: ${sim.targetFloor ?? "—"}   вызовы: ${sim.hallCalls.size}  приказы: ${sim.carCalls.size}`
    : "[ дисплей погашен — нет питания ]";
  // приямок
  $("pitStopToggle").textContent = sim.pitStop ? "СТОП приямка НАЖАТА" : "СТОП приямка отжата";
  $("pitStopToggle").classList.toggle("on", sim.pitStop);

  // приборы
  $("mPos").textContent = `${sim.carPosM.toFixed(2)} м`;
  $("mSpeed").textContent = `${sim.carVelMps >= 0 ? "+" : ""}${sim.carVelMps.toFixed(2)} м/с`;
  const offMm = Math.round((sim.carPosM - sim.floorPosM(sim.nearestFloor())) * 1000);
  $("mFloor").textContent = `${sim.displayFloor()} (${offMm >= 0 ? "+" : ""}${offMm} мм)`;
  $("mDoor").textContent = doorWord();
  $("mTarget").textContent = sim.targetFloor === null ? "—" : `этаж ${sim.targetFloor}${sim.targetIsRescue ? " (доводка)" : ""}`;
  $("mSafety").textContent = reasons.length ? reasons.join("; ") : "цела";
  $("mStarts").textContent = `${sim.starts} · ${sim.distanceM >= 1000 ? (sim.distanceM / 1000).toFixed(2) + " км" : Math.round(sim.distanceM) + " м"}`;
  $("mFaults").textContent = String(sim.emergencyStops);

  // задания
  const state = { ...ach, roofDriveDone: ach.roofDrive >= CFG.floorHeightM };
  const sig = tasksDef.map(([k]) => (state[k] ? "1" : "0")).join("");
  if (sig !== lastTaskSig) {
    lastTaskSig = sig;
    $("tasks").innerHTML = tasksDef.map(([k, txt]) =>
      `<li class="${state[k] ? "done" : ""}">${state[k] ? "✔" : "○"} ${txt}</li>`).join("");
  }
  // журнал и звуки событий
  if (sim.events.length !== lastLogCount) {
    lastLogCount = sim.events.length;
    $("log").innerHTML = sim.events.slice(-70).map(e =>
      `<div class="${e.kind}"><span class="t">${fmtTime(e.t)}</span> ${e.text}</div>`).join("");
    $("log").scrollTop = $("log").scrollHeight;
  }
  while (seenEvents < sim.events.length) {
    const e = sim.events[seenEvents++];
    if (e.kind === "ding" && (location === "cabin" || (location === "landing" && sim.doorZoneFloor() === playerFloor))) ding();
    if (e.kind === "alarm") { tone(440, 0.12, 0.05); tone(440, 0.12, 0.05, 0.16); }
  }
}

function doorWord() {
  return { closed: "закрыты", opening: `открываются ${Math.round(sim.door * 100)}%`,
           open: "открыты", closing: `закрываются ${Math.round(sim.door * 100)}%` }[sim.doorState];
}
function landingDesc() {
  if (sim.manualLandingFloor === playerFloor && sim.manualLandingOpening > 0.5) {
    const rel = relToPlayerFloorM();
    if (Math.abs(rel) <= 0.26) return "ДШ открыта треугольником. Кабина стоит у этажа — за дверями шахты двери кабины.";
    const roofDelta = roofAbsM() - sim.floorPosM(playerFloor);
    if (roofAccessibleFrom(playerFloor)) return `ДШ открыта. Крыша кабины на ${Math.abs(roofDelta).toFixed(2)} м ниже порога — можно шагнуть на неё.`;
    return `ДШ открыта, а кабины здесь нет — перед тобой шахта. Кабина сейчас ${rel > 0 ? "выше" : "ниже"} (этаж ${sim.displayFloor()}).`;
  }
  if (carServesPlayerFloor()) return "Лифт прибыл, двери открыты. Заходи — или сначала посмотри на всё глазами механика.";
  return "Обычная площадка. Вызывной пост справа, отверстие под треугольный ключ — на правой створке ДШ.";
}
function cabinDesc() {
  if (!sim.stopped) return `Едем. Скорость ${Math.abs(sim.carVelMps).toFixed(2)} м/с — следи за индикатором и звуком проходящих этажей.`;
  if (sim.door > 0.7) return `Стоим с открытыми дверьми на этаже ${sim.displayFloor()}.`;
  return sim.powerOn ? "Стоим с закрытыми дверьми. Нажми этаж на панели приказа."
                      : "Питания нет, горит аварийный свет. Хорошо, что это только игра.";
}
function roofDesc() {
  if (!sim.stopped) return sim.roofInspection ? "Едем в ревизии: этажные проёмы проходят мимо с настоящей скоростью."
    : "⚠ Лифт поехал по вызову, а ты на крыше и переключатель в НОРМЕ. Вот зачем нужен перевод в ревизию!";
  const f = landingAccessibleFromRoof();
  return `Стоишь на крыше кабины на высоте ${roofAbsM().toFixed(2)} м.` +
    (f !== null ? ` Порог этажа ${f} рядом — можно выйти.` : " Рядом нет порога этажа: доведи кабину ревизией, пока крыша не встанет чуть ниже порога.");
}
function roofHint() {
  if (sim.roofStop) return "СТОП нажат: привод заблокирован, кнопки ВВЕРХ/ВНИЗ не сработают, пока не отожмёшь.";
  if (!sim.roofInspection) return "Переключатель в НОРМЕ: станция слушается вызовов. Для работы с крыши переведи его в РЕВИЗИЮ.";
  return `Ревизия активна: удерживай ВВЕРХ или ВНИЗ — кабина идёт на ${CFG.inspectionSpeedMps} м/с. Отпустил — встала.`;
}
function landingHint() {
  if (!sim.powerOn) return "Питания у станции нет — вызовы не регистрируются. Питание включается из шкафа управления.";
  if (sim.effectiveMode() === "inspection") return "Станция в ревизии/сервисе: вызовы зажигаются, но кабина по ним не поедет.";
  if (sim.manualLandingFloor !== null && sim.manualLandingOpening > 0.03)
    return `Цепь безопасности разомкнута ДШ этажа ${sim.manualLandingFloor} — в нормальной работе лифт не поедет, пока дверь не защёлкнется.`;
  return "Вызов регистрируется станцией и обслуживается по собирательной логике.";
}

// ---------- Главный цикл ----------
let lastTs = performance.now(), wasMoving = false, prevDisplayFloor = sim.displayFloor();
function frame(ts) {
  const dtAll = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  let rest = dtAll;
  const posBefore = sim.carPosM;
  while (rest > 0) { const step = Math.min(rest, 0.01); sim.tick(step); rest -= step; }
  tickNeighbours(dtAll);

  if (location === "cabin") {
    rideDistanceInside += Math.abs(sim.carPosM - posBefore);
    if (rideDistanceInside > CFG.floorHeightM * 0.8) ach.rode = true;
  }
  if (location === "roof") ach.roofDrive += Math.abs(sim.carPosM - posBefore);

  // звуки движения
  if (!wasMoving && !sim.stopped) contactor();
  if (wasMoving && sim.stopped) { contactor(); clunk(); }
  wasMoving = !sim.stopped;
  const df = sim.displayFloor();
  if (df !== prevDisplayFloor) {
    if (!sim.stopped && (location === "cabin" || location === "roof")) clunk();
    prevDisplayFloor = df;
  }
  if (motorGain) {
    const v = Math.abs(sim.carVelMps);
    let level = v * (location === "cabin" || location === "roof" ? 0.05 : 0.018);
    motorGain.gain.setTargetAtTime(muted ? 0 : level, actx.currentTime, 0.08);
    motorOsc.frequency.setTargetAtTime(38 + v * 34, actx.currentTime, 0.1);
  }

  draw();
  updateUI();
  requestAnimationFrame(frame);
}
sim.log("Подсказка: вызови лифт кнопкой ▲, заезжай на верхний этаж — там шкаф управления. А потом — треугольник и крыша кабины.");
requestAnimationFrame(frame);
