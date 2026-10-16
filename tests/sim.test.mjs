import assert from "node:assert/strict";
import { ElevatorSim } from "../src/sim.js";
import { ELEVATOR } from "../src/config.js";

function run(sim, seconds) {
  for (let t = 0; t < seconds; t += 0.01) sim.tick(0.01);
}
function runUntil(sim, predicate, maxSeconds = 30) {
  for (let t = 0; t < maxSeconds; t += 0.01) {
    sim.tick(0.01);
    if (predicate()) return true;
  }
  return false;
}

// 1) Обычная поездка 1 -> 5: точная остановка и открытие дверей
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.registerCarCall(5);
  assert.ok(runUntil(sim, () => sim.door > 0.9), "двери должны открыться после прибытия в течение 30 с");
  assert.equal(sim.nearestFloor(), 5, "кабина должна прибыть на 5-й этаж");
  assert.ok(Math.abs(sim.carPosM - sim.floorPosM(5)) < 0.005, "точная остановка в пределах 5 мм");
  assert.ok(sim.door > 0.9, "двери должны открыться по прибытии");
  assert.ok(sim.starts >= 1 && sim.distanceM > 10, "счётчики пусков и пробега работают");
  console.log("✓ поездка 1→5, точная остановка, двери открылись");
}

// 2) Треугольник во время движения: цепь безопасности -> аварийная остановка -> доводка
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.registerCarCall(9);
  run(sim, 4); // на полном ходу
  assert.ok(Math.abs(sim.carVelMps) > 0.5, "кабина на скорости");
  sim.openManualLandingDoor(3);
  run(sim, 3);
  assert.ok(sim.stopped, "кабина обязана встать при разомкнутой цепи безопасности");
  assert.ok(sim.emergencyStops >= 1, "аварийная остановка подсчитана");
  assert.equal(sim.targetFloor, null, "задание сброшено");
  sim.closeManualLandingDoor();
  assert.ok(runUntil(sim, () => sim.atFloorExact() && sim.door > 0.9, 30), "после восстановления цепи — доводка и открытие дверей");
  assert.ok(sim.atFloorExact(), "после восстановления цепи — доводка до этажа");
  assert.ok(sim.door > 0.9, "двери открылись после доводки");
  console.log("✓ треугольник на ходу: стоп → закрыл ДШ → доводка до этажа");
}

// 3) Ревизия: едем только пока держим кнопку, не быстрее ревизионной скорости
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.setRoofInspection(true);
  sim.registerCarCall(7); // должен игнорироваться в ревизии
  run(sim, 3);
  assert.ok(sim.stopped && sim.carPosM === 0, "в ревизии без кнопок стоим");
  sim.roofUpHeld = true;
  let vmax = 0;
  for (let t = 0; t < 4; t += 0.01) { sim.tick(0.01); vmax = Math.max(vmax, Math.abs(sim.carVelMps)); }
  assert.ok(vmax <= ELEVATOR.inspectionSpeedMps + 0.001, `скорость ревизии ограничена (${vmax})`);
  assert.ok(sim.carPosM > 0.8, "кабина поднялась в ревизии");
  sim.roofUpHeld = false;
  run(sim, 2);
  assert.ok(sim.stopped, "отпустил кнопку — встал");
  // концевой выключатель внизу
  sim.roofDownHeld = true;
  run(sim, 12);
  assert.ok(sim.carPosM >= -0.120001, "нижний концевой не пускает ниже");
  sim.roofDownHeld = false;
  console.log("✓ ревизия: удержание кнопки, лимит скорости, концевой");
}

// 4) Снятие питания на ходу: тормоз, после подачи — доводка
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.registerHallCall(6, "down");
  run(sim, 4);
  sim.setPower(false);
  run(sim, 3);
  assert.ok(sim.stopped, "без питания кабина стоит на тормозе");
  sim.setPower(true);
  run(sim, 30);
  assert.ok(sim.atFloorExact(), "после подачи питания кабина доехала до этажа");
  console.log("✓ отключение питания: тормоз → доводка");
}

// 5) Фирменный характер: стук с 1-го, долгое выравнивание и громкий стук на 10-м
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.registerCarCall(10);
  assert.ok(runUntil(sim, () => sim.levelingFloor === 10, 45), "на 10-м должно начаться долгое выравнивание");
  assert.ok(sim.events.some(e => e.kind === "knock1"), "при подъёме с 1-го должен быть характерный стук");
  assert.ok(sim.events.some(e => e.kind === "knock10"), "на 10-м должен быть громкий стук");
  assert.ok(sim.door < 0.1, "во время выравнивания двери закрыты");
  assert.ok(Math.abs(sim.carPosM - sim.floorPosM(10)) > 0.045, "сначала кабина встаёт заметно ниже уровня 10-го");
  run(sim, 5);
  assert.equal(sim.levelingFloor, 10, "через 5 с выравнивание ещё должно идти");
  assert.ok(runUntil(sim, () => sim.door > 0.9, 8), "после ~8 с выравнивания двери открываются");
  assert.ok(Math.abs(sim.carPosM - sim.floorPosM(10)) < 0.002, "в конце выравнивания — точный уровень");
  console.log("✓ характер лифта: стук с 1-го, 8 с выравнивания и БАМ на 10-м");
}

// 6) Сервисная панель кабины: Лифтёр / Спецзагрузка / Удержание дверей / Вентилятор / Запасной
{
  const sim = new ElevatorSim(ELEVATOR);
  sim.setAttendant(true);
  assert.ok(sim.registerHallCall(6, "up"), "в режиме Лифтёр вызов регистрируется");
  run(sim, 4);
  assert.ok(sim.carPosM === 0 && sim.targetFloor === null, "в режиме Лифтёр по одному вызову кабина не едет");
  sim.registerCarCall(6);
  assert.ok(runUntil(sim, () => sim.door > 0.9, 35), "по приказу лифтёра кабина приезжает");
  run(sim, ELEVATOR.doorDwellTimeS + 3);
  assert.ok(sim.door > 0.9, "в режиме Лифтёр двери не закрываются сами");
  sim.setAttendant(false);
  sim.doorCloseCommand();

  const sim2 = new ElevatorSim(ELEVATOR);
  sim2.setSpecialLoad(true);
  assert.equal(sim2.registerHallCall(4, "up"), false, "при Спецзагрузке вызовы с этажей не принимаются");
  sim2.setDoorHold(true);
  sim2.registerCarCall(2);
  assert.ok(runUntil(sim2, () => sim2.door > 0.9, 20), "приказ при Спецзагрузке выполняется");
  run(sim2, ELEVATOR.specialLoadDoorDwellS + 2);
  assert.ok(sim2.door > 0.9, "Удержание дверей не даёт дверям закрыться даже после увеличенной стоянки");
  sim2.setFan(true); sim2.setSpare(true);
  assert.ok(sim2.fanOn && sim2.spareSwitchOn, "Вентилятор и Запасной переключаются");
  console.log("✓ сервисная панель: все пять переключателей работают");
}

console.log("\nВсе тесты модели лифта пройдены.");
