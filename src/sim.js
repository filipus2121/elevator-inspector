// ============================================================================
// МОДЕЛЬ ЛИФТА BLT-NS — честная физика движения, двери, цепь безопасности,
// режимы станции (нормальная работа / ревизия / шит управления / без питания).
// Модель ничего не рисует: это чистый "лифт в коробке", который можно тестировать.
// ============================================================================
import { ELEVATOR } from "./config.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const approach = (v, target, maxDelta) =>
  v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target);

export class ElevatorSim {
  constructor(cfg = ELEVATOR) {
    this.cfg = cfg;
    this.time = 0;

    // --- Непрерывное положение кабины: 0 = пол кабины вровень с 1-м этажом
    this.carPosM = 0;
    this.carVelMps = 0;
    this.lastDirection = 1;
    this.targetFloor = null;
    this.targetIsRescue = false;
    this.targetUseTopLeveling = false; // фиксируется один раз при выборе задания на верхний этаж

    // --- Долгое выравнивание на верхнем этаже (особенность этого лифта)
    this.levelingFloor = null;
    this.levelingRemainingS = 0;
    this.levelingDurationS = 0;
    this.levelingStartPosM = 0;

    // --- Двери кабины (0 = закрыты, 1 = полностью открыты)
    this.door = 0;
    this.doorState = "closed"; // closed | opening | open | closing
    this.doorTimerS = 0;
    this.doorManualHold = false; // двери раздвинуты руками — автоматом не закрываются
    this.doorManualMotion = false; // текущее движение дверей — ручное (работает без питания)

    // --- Дверь шахты, открытая треугольным ключом (только одна за раз)
    this.manualLandingFloor = null;
    this.manualLandingOpening = 0;
    this.manualLandingTarget = 0;

    // --- Вызовы и приказы
    this.carCalls = new Set();
    this.hallCalls = new Set(); // ключи "этаж:up" / "этаж:down"

    // --- Станция управления и защита
    this.powerOn = true;
    this.roofInspection = false; // переключатель РЕВИЗИЯ на крыше кабины
    this.cabinetService = false; // сервисный режим из шкафа управления
    this.roofStop = false;       // кнопка СТОП на крыше
    this.pitStop = false;        // кнопка СТОП в приямке

    // --- Сервисная панель на ключе внизу поста приказа [данные владельца]
    this.attendantMode = false;  // «Лифтёр»: вызовы только регистрируются, едем по приказам, двери сами не закрываются
    this.specialLoadMode = false; // «Специальная загрузка»: вызовы с этажей не принимаются, двери стоят дольше
    this.doorHoldMode = false;   // «Удержание дверей»: открытые двери не закрываются автоматически
    this.fanOn = false;          // «Вентилятор» в кабине
    this.spareSwitchOn = false;  // «Запасной»: пока ни к чему не подключён

    // --- Удерживаемые кнопки ревизии (их ставит интерфейс)
    this.roofUpHeld = false; this.roofDownHeld = false;
    this.cabinetUpHeld = false; this.cabinetDownHeld = false;

    // --- Счётчики «паспорта лифта»
    this.starts = 0;
    this.distanceM = 0;
    this.emergencyStops = 0;

    this.events = [];
    this._lowLimitLogged = false;
    this._highLimitLogged = false;
    this._knock1Armed = false;
    this.log(`Шкаф ${cfg.controllerType ?? cfg.model} включён. Самотестирование OK, кабина на этаже ${cfg.firstFloor}.`);
  }

  // ---------- Геометрия шахты ----------
  get minFloor() { return this.cfg.firstFloor; }
  get maxFloor() { return this.cfg.firstFloor + this.cfg.floors - 1; }
  get topPosM() { return (this.cfg.floors - 1) * this.cfg.floorHeightM; }
  floorPosM(floor) { return (floor - this.cfg.firstFloor) * this.cfg.floorHeightM; }
  validFloor(f) { return Number.isInteger(f) && f >= this.minFloor && f <= this.maxFloor; }
  nearestFloor() {
    const idx = clamp(Math.round(this.carPosM / this.cfg.floorHeightM), 0, this.cfg.floors - 1);
    return this.cfg.firstFloor + idx;
  }
  displayFloor() { return this.nearestFloor(); }
  /** Этаж, в зоне которого можно открывать двери (иначе null). */
  doorZoneFloor() {
    const f = this.nearestFloor();
    return Math.abs(this.carPosM - this.floorPosM(f)) <= 0.25 ? f : null;
  }
  atFloorExact(floor = this.nearestFloor()) {
    return Math.abs(this.carPosM - this.floorPosM(floor)) <= 0.03;
  }
  get stopped() { return Math.abs(this.carVelMps) < 0.001; }

  // ---------- Журнал ----------
  log(text, kind = "info") {
    this.events.push({ t: this.time, text, kind });
    if (this.events.length > 250) this.events.shift();
  }

  // ---------- Режимы и цепь безопасности ----------
  effectiveMode() {
    if (!this.powerOn) return "off";
    if (this.roofInspection || this.cabinetService) return "inspection";
    return "normal";
  }
  /** Что именно размыкает цепь безопасности (без учёта дверей кабины на стоянке). */
  safetyReasons() {
    const r = [];
    if (this.manualLandingFloor !== null && this.manualLandingOpening > 0.03)
      r.push(`замок ДШ этажа ${this.manualLandingFloor} открыт (треугольник)`);
    if (this.roofStop) r.push("СТОП на крыше кабины нажат");
    if (this.pitStop) r.push("СТОП в приямке нажат");
    return r;
  }
  get safetyOk() { return this.safetyReasons().length === 0; }
  get doorsFullyClosed() { return this.door <= 0.001 && this.doorState === "closed"; }
  canRunNormal() {
    return this.powerOn && this.effectiveMode() === "normal" && this.safetyOk && this.doorsFullyClosed;
  }
  canRunInspection() {
    return this.powerOn && this.effectiveMode() === "inspection" && !this.roofStop && !this.pitStop;
  }

  // ---------- Вызовы / приказы ----------
  registerCarCall(floor) {
    if (!this.validFloor(floor) || !this.powerOn) return false;
    if (this._servingFloorNow(floor)) return true;
    this.carCalls.add(floor);
    this.log(`Приказ: этаж ${floor}.`);
    return true;
  }
  registerHallCall(floor, dir) {
    if (!this.validFloor(floor) || !this.powerOn) return false;
    if (dir === "up" && floor === this.maxFloor) return false;
    if (dir === "down" && floor === this.minFloor) return false;
    if (this.specialLoadMode) {
      this.log(`Вызов с этажа ${floor} не принят: включена «Специальная загрузка».`, "warn");
      return false;
    }
    if (this._servingFloorNow(floor)) return true;
    this.hallCalls.add(`${floor}:${dir}`);
    this.log(`Вызов: этаж ${floor} ${dir === "up" ? "▲" : "▼"}${this.attendantMode ? " (зарегистрирован, лифтёр решит сам)" : ""}.`);
    return true;
  }
  effectiveDoorDwellS() {
    return this.specialLoadMode ? (this.cfg.specialLoadDoorDwellS ?? this.cfg.doorDwellTimeS) : this.cfg.doorDwellTimeS;
  }
  _servingFloorNow(floor) {
    if (this.stopped && this.atFloorExact(floor) && (this.doorState === "open" || this.doorState === "opening")) {
      this.doorTimerS = Math.max(this.doorTimerS, this.effectiveDoorDwellS()); // продлеваем стоянку
      return true;
    }
    return false;
  }
  requestedFloors() {
    const s = new Set(this.carCalls);
    for (const k of this.hallCalls) s.add(Number(k.split(":")[0]));
    return [...s];
  }
  /** Что станция реально обслужит автоматически с учётом «Лифтёра» и «Спецзагрузки». */
  dispatchableFloors() {
    if (this.attendantMode || this.specialLoadMode) return [...this.carCalls];
    return this.requestedFloors();
  }
  clearFloorRequests(floor) {
    this.carCalls.delete(floor);
    this.hallCalls.delete(`${floor}:up`);
    this.hallCalls.delete(`${floor}:down`);
  }

  // ---------- Двери кабины ----------
  doorOpenCommand(manual = false) {
    if (!this.stopped || this.doorZoneFloor() === null) return false;
    if (!manual && !this.powerOn) return false;
    if (this.doorState === "open" || this.doorState === "opening") {
      this.doorTimerS = Math.max(this.doorTimerS, this.effectiveDoorDwellS());
      return true;
    }
    const wasClosed = this.doorState === "closed";
    this.doorState = "opening";
    this.doorManualMotion = manual;
    this.doorManualHold = manual;
    if (wasClosed) this.log(`Этаж ${this.doorZoneFloor()}. Двери открываются.`, manual ? "info" : "ding");
    return true;
  }
  doorCloseCommand(manual = false) {
    if (this.doorState !== "open" && this.doorState !== "opening") return false;
    if (!manual && !this.powerOn) return false;
    this.doorState = "closing";
    this.doorManualMotion = manual;
    this.doorManualHold = false;
    this.log("Двери закрываются.");
    return true;
  }

  // ---------- Дверь шахты треугольником ----------
  openManualLandingDoor(floor) {
    if (!this.validFloor(floor)) return false;
    if (this.manualLandingFloor !== null && this.manualLandingFloor !== floor) return false;
    this.manualLandingFloor = floor;
    this.manualLandingTarget = 1;
    this.log(`🔓 ДШ этажа ${floor} разблокирована треугольным ключом. Цепь безопасности разомкнута.`, "warn");
    return true;
  }
  closeManualLandingDoor() {
    if (this.manualLandingFloor === null) return;
    this.manualLandingTarget = 0;
    this.log(`ДШ этажа ${this.manualLandingFloor} отпущена — доводчик закрывает дверь.`);
  }
  landingDoorOpeningAt(floor) {
    let o = 0;
    if (this.manualLandingFloor === floor) o = this.manualLandingOpening;
    if (this.doorZoneFloor() === floor) o = Math.max(o, this.door); // отводка тянет ДШ за кабиной
    return o;
  }

  // ---------- Переключатели станции ----------
  _tripEmergency(why) {
    if (!this.stopped) {
      this.emergencyStops++;
      this.log(`⚠ Аварийная остановка: ${why}. Тормоз наложен.`, "alarm");
    }
    this.targetFloor = null;
    this.targetIsRescue = false;
    this.targetUseTopLeveling = false;
    this.levelingFloor = null;
    this.levelingRemainingS = 0;
  }
  setPower(on) {
    if (this.powerOn === on) return;
    this.powerOn = on;
    if (!on) { this._tripEmergency("отключено питание"); this.log("⛔ Главный выключатель: питание станции снято.", "alarm"); }
    else this.log("Питание станции подано. Самотестирование OK.");
  }
  setRoofInspection(on) {
    if (this.roofInspection === on) return;
    this.roofInspection = on;
    if (on) { this._tripEmergency("перевод в ревизию"); this.log("Пост ревизии: режим РЕВИЗИЯ. Вызовы и приказы игнорируются."); }
    else this.log("Пост ревизии: возвращено в НОРМАЛЬНУЮ работу.");
  }
  setCabinetService(on) {
    if (this.cabinetService === on) return;
    this.cabinetService = on;
    if (on) { this._tripEmergency("сервисный режим шкафа"); this.log("Шкаф управления: сервисный режим, управление с панели шкафа."); }
    else this.log("Шкаф управления: возврат в нормальную работу.");
  }
  setRoofStop(on) {
    if (this.roofStop === on) return;
    this.roofStop = on;
    if (on) this._tripEmergency("СТОП на крыше");
    this.log(on ? "СТОП на крыше НАЖАТ — привод заблокирован." : "СТОП на крыше отжата.", on ? "warn" : "info");
  }
  setPitStop(on) {
    if (this.pitStop === on) return;
    this.pitStop = on;
    if (on) this._tripEmergency("СТОП приямка");
    this.log(on ? "СТОП в приямке НАЖАТ — привод заблокирован." : "СТОП в приямке отжата.", on ? "warn" : "info");
  }

  // ---------- Сервисная панель кабины (на ключе) ----------
  setAttendant(on) {
    if (this.attendantMode === on) return;
    this.attendantMode = on;
    this.log(on
      ? "Сервисная панель: «Лифтёр» ВКЛ. Вызовы только регистрируются лампами; кабина едет по приказам, двери закрывает лифтёр кнопкой."
      : "Сервисная панель: «Лифтёр» ВЫКЛ — снова автоматическая работа по вызовам.");
  }
  setSpecialLoad(on) {
    if (this.specialLoadMode === on) return;
    this.specialLoadMode = on;
    if (on) {
      this.hallCalls.clear();
      if (this.doorState === "open") this.doorTimerS = Math.max(this.doorTimerS, this.effectiveDoorDwellS());
      this.log("Сервисная панель: «Специальная загрузка» ВКЛ. Вызовы с этажей сброшены и не принимаются; двери на остановках стоят дольше.");
    } else this.log("Сервисная панель: «Специальная загрузка» ВЫКЛ.");
  }
  setDoorHold(on) {
    if (this.doorHoldMode === on) return;
    this.doorHoldMode = on;
    this.log(on
      ? "Сервисная панель: «Удержание дверей» ВКЛ — открытые двери сами не закроются."
      : "Сервисная панель: «Удержание дверей» ВЫКЛ.");
  }
  setFan(on) {
    if (this.fanOn === on) return;
    this.fanOn = on;
    this.log(on ? "Сервисная панель: вентилятор кабины включён." : "Сервисная панель: вентилятор выключен.");
  }
  setSpare(on) {
    if (this.spareSwitchOn === on) return;
    this.spareSwitchOn = on;
    this.log(`Сервисная панель: «Запасной» переключён в ${on ? "ВКЛ" : "ВЫКЛ"}… и ничего не произошло. Он и правда запасной.`);
  }

  // ---------- Главный шаг ----------
  tick(dt) {
    if (dt <= 0) return;
    this.time += dt;
    const prevPos = this.carPosM;
    const wasMoving = !this.stopped;

    this._tickManualDoor(dt);
    this._tickCarDoor(dt);

    const mode = this.effectiveMode();
    if (mode === "inspection") this._tickInspection(dt);
    else if (mode === "normal") this._tickNormal(dt);
    else this._brake(dt, this.cfg.emergencyDecelMps2); // без питания — только тормоз

    // Фирменный характер: стук при подъёме именно с 1-го этажа
    if (wasMoving === false && this.atFloorExact(this.minFloor)) this._knock1Armed = true;
    if (this._knock1Armed && this.cfg.knockDepartingFirstFloor && this.carVelMps > 0.05 && this.carPosM >= 0.35) {
      this.log("ТУК! Характерный стук при подъёме с 1-го этажа — он у этого лифта всегда такой.", "knock1");
      this._knock1Armed = false;
    }
    if (this.stopped && !this.atFloorExact(this.minFloor)) this._knock1Armed = false;

    this.distanceM += Math.abs(this.carPosM - prevPos);
    if (!wasMoving && !this.stopped) this.starts++;
  }

  _tickNormal(dt) {
    if (!this.canRunNormal()) {
      if (!this.stopped && (this.targetFloor !== null || this.levelingFloor !== null)) this._tripEmergency(this.safetyReasons()[0] ?? "цепь безопасности разомкнута");
      this._brake(dt, this.cfg.emergencyDecelMps2);
      return;
    }
    if (this.levelingFloor !== null) { this._tickLeveling(dt); return; }
    if (this.targetFloor === null && this.stopped) this._chooseNextTarget();
    if (this.targetFloor !== null) this._moveTowardTarget(dt);
    else this._brake(dt, this.cfg.accelerationMps2);
  }

  _chooseNextTarget() {
    if (!this.doorsFullyClosed) return;
    const nearest = this.nearestFloor();
    // Встали между этажами (после аварии/ревизии) -> доводка до ближайшего
    if (!this.atFloorExact(nearest)) {
      this.targetFloor = nearest;
      this.targetIsRescue = true;
      this.targetUseTopLeveling = false;
      this.log(`Доводка: станция везёт кабину на ближайший этаж ${nearest} на малой скорости.`);
      return;
    }
    const req = this.dispatchableFloors();
    if (req.length === 0) return;
    if (req.includes(nearest)) { this.clearFloorRequests(nearest); this.doorOpenCommand(); return; }
    const ahead = req.filter(f => Math.sign(this.floorPosM(f) - this.carPosM) === this.lastDirection);
    const pool = ahead.length ? ahead : req;
    pool.sort((a, b) => Math.abs(this.floorPosM(a) - this.carPosM) - Math.abs(this.floorPosM(b) - this.carPosM));
    this.targetFloor = pool[0];
    this.targetIsRescue = false;
    // Решение о долгом выравнивании принимаем ЗДЕСЬ, один раз на всю поездку.
    // Если пересчитывать его на ходу, условие по расстоянию само выключится у цели.
    this.targetUseTopLeveling = this.targetFloor === this.maxFloor &&
      (this.cfg.topFloorLevelingS ?? 0) > 0 &&
      this.floorPosM(this.targetFloor) - this.carPosM > (this.cfg.topFloorLevelingOffsetM ?? 0) + 0.05;
    this.lastDirection = this.floorPosM(this.targetFloor) > this.carPosM ? 1 : -1;
  }

  _moveTowardTarget(dt) {
    const finalPos = this.floorPosM(this.targetFloor);
    // На верхнем этаже этот лифт сначала встаёт ниже уровня и потом долго выравнивается
    const levelingOffset = this.cfg.topFloorLevelingOffsetM ?? 0;
    const useTopLeveling = this.targetUseTopLeveling && this.targetFloor === this.maxFloor && !this.targetIsRescue;
    const targetPos = useTopLeveling ? finalPos - levelingOffset : finalPos;
    const dist = targetPos - this.carPosM;
    const vmax = this.targetIsRescue ? this.cfg.rescueSpeedMps : this.cfg.ratedSpeedMps;
    const a = this.cfg.accelerationMps2;
    let allowed = Math.min(vmax, Math.sqrt(2 * a * Math.abs(dist)));
    if (Math.abs(dist) > 0.004) allowed = Math.max(allowed, 0.07);
    const desired = Math.sign(dist) * allowed;
    this.carVelMps = approach(this.carVelMps, desired, a * dt);
    if (this.carVelMps !== 0) this.lastDirection = Math.sign(this.carVelMps);
    const newPos = this.carPosM + this.carVelMps * dt;
    const crossed = Math.sign(targetPos - newPos) !== Math.sign(dist) || newPos === targetPos;
    if ((crossed && Math.abs(dist) < 0.05) || Math.abs(dist) <= 0.002) {
      this.carPosM = targetPos;
      this.carVelMps = 0;
      const arrived = this.targetFloor;
      this.targetFloor = null; this.targetIsRescue = false; this.targetUseTopLeveling = false;
      if (useTopLeveling) this._startTopFloorLeveling(arrived);
      else { this.clearFloorRequests(arrived); this.doorOpenCommand(); }
    } else {
      this.carPosM = newPos;
    }
  }

  _startTopFloorLeveling(floor) {
    this.levelingFloor = floor;
    this.levelingDurationS = this.cfg.topFloorLevelingS;
    this.levelingRemainingS = this.levelingDurationS;
    this.levelingStartPosM = this.carPosM;
    const offMm = Math.round(Math.abs(this.floorPosM(floor) - this.carPosM) * 1000);
    this.log(this.cfg.loudKnockTopFloor
      ? `БАМ! Очень громкий стук на ${floor}-м этаже. Кабина встала на ${offMm} мм ниже и начала своё долгое выравнивание…`
      : `Этаж ${floor}: начато выравнивание с отклонением ${offMm} мм.`, "knock10");
  }

  _tickLeveling(dt) {
    const floor = this.levelingFloor;
    const finalPos = this.floorPosM(floor);
    this.levelingRemainingS = Math.max(0, this.levelingRemainingS - dt);
    const elapsed = this.levelingDurationS - this.levelingRemainingS;
    const p = clamp(elapsed / this.levelingDurationS, 0, 1);
    const eased = p * p * (3 - 2 * p);
    const residual = (this.levelingStartPosM - finalPos) * (1 - eased);
    const hunting = Math.sin(elapsed * 2.1) * 0.004 * (1 - p); // лёгкая «охота» вокруг уровня
    const newPos = finalPos + residual + hunting;
    this.carVelMps = dt > 0 ? (newPos - this.carPosM) / dt : 0;
    this.carPosM = newPos;
    if (this.levelingRemainingS <= 0) {
      this.carPosM = finalPos;
      this.carVelMps = 0;
      this.levelingFloor = null;
      this.log(`Выравнивание на ${floor}-м завершено: заняло ${this.levelingDurationS.toFixed(0)} с, теперь точно ±0 мм.`);
      this.clearFloorRequests(floor);
      this.doorOpenCommand();
    }
  }

  _inspectionDir() {
    if (this.roofInspection) {
      if (this.roofUpHeld && !this.roofDownHeld) return 1;
      if (this.roofDownHeld && !this.roofUpHeld) return -1;
    }
    if (this.cabinetService) {
      if (this.cabinetUpHeld && !this.cabinetDownHeld) return 1;
      if (this.cabinetDownHeld && !this.cabinetUpHeld) return -1;
    }
    return 0;
  }

  _tickInspection(dt) {
    if (!this.canRunInspection()) { this._brake(dt, this.cfg.emergencyDecelMps2); return; }
    const dir = this._inspectionDir();
    const lowLimit = -0.12, highLimit = this.topPosM + 0.12;
    let desired = dir * this.cfg.inspectionSpeedMps;
    if (dir < 0 && this.carPosM <= lowLimit) {
      desired = 0; this.carPosM = lowLimit;
      if (!this._lowLimitLogged) { this.log("Нижний концевой выключатель. Дальше вниз — буфер.", "warn"); this._lowLimitLogged = true; }
    } else if (dir < 0) this._highLimitLogged = false;
    if (dir > 0 && this.carPosM >= highLimit) {
      desired = 0; this.carPosM = highLimit;
      if (!this._highLimitLogged) { this.log("Верхний концевой выключатель. Выше только перекрытие шахты.", "warn"); this._highLimitLogged = true; }
    } else if (dir > 0) this._lowLimitLogged = false;
    this.carVelMps = approach(this.carVelMps, desired, 0.6 * dt);
    if (this.carVelMps !== 0) this.lastDirection = Math.sign(this.carVelMps);
    this.carPosM = clamp(this.carPosM + this.carVelMps * dt, lowLimit, highLimit);
  }

  _brake(dt, decel) {
    this.carVelMps = approach(this.carVelMps, 0, decel * dt);
    this.carPosM = clamp(this.carPosM + this.carVelMps * dt, -0.35, this.topPosM + 0.35);
  }

  _tickCarDoor(dt) {
    const powered = this.powerOn || this.doorManualMotion;
    if (this.doorState === "opening" && powered) {
      this.door = clamp(this.door + dt / this.cfg.doorOpenTimeS, 0, 1);
      if (this.door >= 1) { this.doorState = "open"; this.doorTimerS = this.effectiveDoorDwellS(); }
    } else if (this.doorState === "open") {
      if (!this.doorManualHold && this.powerOn && !this.doorHoldMode && !this.attendantMode) {
        this.doorTimerS -= dt;
        if (this.doorTimerS <= 0) this.doorCloseCommand();
      }
    } else if (this.doorState === "closing" && powered) {
      this.door = clamp(this.door - dt / this.cfg.doorCloseTimeS, 0, 1);
      if (this.door <= 0) { this.doorState = "closed"; this.doorManualMotion = false; }
    }
  }

  _tickManualDoor(dt) {
    if (this.manualLandingFloor === null) return;
    const rate = this.manualLandingTarget === 1 ? dt / 0.9 : dt / 1.1;
    this.manualLandingOpening = approach(this.manualLandingOpening, this.manualLandingTarget, rate);
    if (this.manualLandingTarget === 0 && this.manualLandingOpening <= 0) {
      this.log(`ДШ этажа ${this.manualLandingFloor} закрыта, замок защёлкнут. Цепь безопасности восстановлена.`);
      this.manualLandingFloor = null;
    }
  }
}
