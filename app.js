(() => {
  "use strict";

  const { parseNumber, calculateFromPercent, calculateFromPrice, calculateBaselineFromChange, formatNumber } = StockCalculator;
  const STORAGE_KEY = "stock-change-calculator:v2";
  const LEGACY_STORAGE_KEY = "stock-change-calculator:v1";
  // 市場ごとの表示設定。JPは円を後置・6桁、USはドル記号を前置・4桁。率はどちらも2桁。
  const MARKETS = {
    jp: { unit: "円", symbol: "円", priceDigits: 6, fineDigits: null, fineLabel: "" },
    us: { unit: "ドル", symbol: "$", priceDigits: 4, fineDigits: 2, fineLabel: "1セント" }
  };
  // 楽天証券・米国株の手数料（2026-10時点）。通常口座は税抜0.45%＋消費税10%（税込0.495%）、NISAは無料。
  // SEC Feeは売却代金×0.0000206ドル（2026-04-02公表の料率）、最低1セント。
  const RAKUTEN_US = { commissionRate: 0.0045, taxRate: 0.1, secFeeRate: 0.0000206 };
  const defaults = { baseline: "", rate: "", price: "" };
  const fields = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.getElementById(key)]));
  const get = (id) => document.getElementById(id);
  const helper = { price: get("current-price"), change: get("price-change") };
  const helperInputs = Object.values(helper);
  const breakeven = { buy: get("buy-price"), cost: get("cost-basis") };
  const breakevenInputs = Object.values(breakeven);
  const inputs = [...Object.values(fields), ...helperInputs, ...breakevenInputs];
  let storageAvailable = true;
  let market = "jp";
  let rateSign = 1;
  let changeSign = 1;
  let inferredBaseline = null;
  let baselineEdited = false;
  let baselineBeforeEdit = null;
  const states = { jp: emptyState(), us: emptyState() };

  function emptyState() {
    return { baseline: "", rate: "", price: "", rateSign: 1, currentPrice: "", priceChange: "", changeSign: 1, buyPrice: "", costBasis: "" };
  }

  function snapshot() {
    return {
      baseline: fields.baseline.value,
      rate: fields.rate.value,
      price: fields.price.value,
      rateSign,
      currentPrice: helper.price.value,
      priceChange: helper.change.value,
      changeSign,
      buyPrice: breakeven.buy.value,
      costBasis: breakeven.cost.value
    };
  }

  function restore(state) {
    fields.baseline.value = state.baseline;
    fields.rate.value = state.rate;
    fields.price.value = state.price;
    rateSign = state.rateSign;
    helper.price.value = state.currentPrice;
    helper.change.value = state.priceChange;
    changeSign = state.changeSign;
    breakeven.buy.value = state.buyPrice;
    breakeven.cost.value = state.costBasis;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function readState(saved) {
    const state = emptyState();
    for (const key of Object.keys(fields)) {
      // Computed or copied baseline values can have more digits than a typed value.
      const maxLength = key === "rate" ? 32 : 350;
      if (typeof saved[key] === "string" && saved[key].length <= maxLength) state[key] = saved[key];
    }
    if (saved.rateSign === -1 || saved.rateSign === 1) state.rateSign = saved.rateSign;
    if (typeof saved.currentPrice === "string" && saved.currentPrice.length <= 32) state.currentPrice = saved.currentPrice;
    if (typeof saved.priceChange === "string" && saved.priceChange.length <= 32) state.priceChange = saved.priceChange;
    if (saved.changeSign === -1 || saved.changeSign === 1) state.changeSign = saved.changeSign;
    if (typeof saved.buyPrice === "string" && saved.buyPrice.length <= 32) state.buyPrice = saved.buyPrice;
    if (typeof saved.costBasis === "string" && saved.costBasis.length <= 32) state.costBasis = saved.costBasis;
    return state;
  }

  const priceDigits = () => MARKETS[market].priceDigits;
  const unitName = () => MARKETS[market].unit;

  function money(value, digits = priceDigits()) {
    const text = formatNumber(value, digits);
    return market === "us" ? `$${text}` : `${text}円`;
  }

  function signedMoney(value) {
    const magnitude = Math.abs(value);
    if (formatNumber(magnitude, priceDigits()) === "0") return money(0);
    return `${value < 0 ? "−" : "+"}${money(magnitude)}`;
  }

  function applyMarket() {
    const config = MARKETS[market];
    document.documentElement.dataset.market = market;
    for (const button of document.querySelectorAll("[data-market-select]")) {
      button.setAttribute("aria-pressed", String(button.dataset.marketSelect === market));
    }
    for (const element of document.querySelectorAll(".input-unit, .money-unit")) element.textContent = config.symbol;
    for (const element of document.querySelectorAll(".unit-name")) element.textContent = `（${config.unit}）`;
    get("price-stepper").setAttribute("aria-label", `株価を1${config.unit}ずつ調整`);
    get("price-up").setAttribute("aria-label", `1${config.unit}増やす`);
    get("price-down").setAttribute("aria-label", `1${config.unit}減らす`);
    // 二重三角（最小単位の増減）は米株のみ。日本株では隠す。
    const hasFine = config.fineDigits !== null;
    get("price-fine-stepper").hidden = !hasFine;
    get("price-fine-stepper").setAttribute("aria-label", hasFine ? `株価を${config.fineLabel}ずつ調整` : "");
    get("price-fine-up").setAttribute("aria-label", hasFine ? `${config.fineLabel}増やす` : "");
    get("price-fine-down").setAttribute("aria-label", hasFine ? `${config.fineLabel}減らす` : "");
    get("breakeven-card").hidden = market !== "us";
    get("price-help").textContent = hasFine
      ? `現在値や目標の株価を入力してください。右の一重三角で1${config.unit}ずつ、二重三角で${config.fineLabel}ずつ増減できます。`
      : `現在値や目標の株価を入力してください。右の上下ボタンで1${config.unit}ずつ増減できます。`;
  }

  function normalizeMagnitudeInput(field, sign, removeGrouping = true) {
    const normalized = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").trim();
    if (parseNumber(normalized) === null && !/^[+-]$/.test(normalized)) return sign;
    // Move a pasted sign to the separate control; unsigned edits keep its state.
    if (/^[+-]/.test(normalized)) sign = normalized.startsWith("-") ? -1 : 1;
    const magnitude = normalized.replace(/^[+-]/, "");
    field.value = removeGrouping ? magnitude.replaceAll(",", "") : magnitude;
    return sign;
  }

  function normalizeRateInput() {
    rateSign = normalizeMagnitudeInput(fields.rate, rateSign);
  }

  function updateClearButtons() {
    for (const button of document.querySelectorAll("[data-clear]")) {
      button.disabled = get(button.dataset.clear).value.trim() === "";
    }
  }

  function ungroupForEditing(field) {
    const original = field.value;
    if (parseNumber(original) === null) return;
    const ungrouped = original.replace(/[,，]/g, "");
    if (ungrouped === original) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const direction = field.selectionDirection;
    field.value = ungrouped;
    if (start !== null && end !== null) {
      field.setSelectionRange(
        original.slice(0, start).replace(/[,，]/g, "").length,
        original.slice(0, end).replace(/[,，]/g, "").length,
        direction
      );
    }
  }

  function baselineInputValue(value) {
    const [coefficient, exponent] = String(value).split("e");
    if (exponent === undefined) return coefficient;
    const [integer, fraction = ""] = coefficient.split(".");
    const digits = integer + fraction;
    const point = integer.length + Number(exponent);
    if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return digits.padEnd(point, "0");
    return `${digits.slice(0, point)}.${digits.slice(point)}`;
  }

  function updateBaselineHelper() {
    changeSign = normalizeMagnitudeInput(helper.change, changeSign, document.activeElement === helper.change);
    get("change-sign").textContent = changeSign < 0 ? "−" : "+";
    get("change-sign").setAttribute("aria-label", changeSign < 0
      ? "現在マイナス。プラスに切り替え"
      : "現在プラス。マイナスに切り替え");
    const price = parseNumber(helper.price.value);
    const magnitude = parseNumber(helper.change.value);
    const hasPrice = helper.price.value.trim() !== "";
    const hasChange = helper.change.value.trim() !== "";
    let error = "";
    inferredBaseline = null;
    if ((hasPrice && price === null) || (hasChange && (magnitude === null || magnitude < 0))) {
      error = "数字で入力してください。";
    } else if (hasPrice && price < 0) {
      error = `現在値は0${unitName()}以上で入力してください。`;
    } else if ((hasPrice && price > 1e9) || (hasChange && magnitude > 1e9)) {
      error = `金額は10億${unitName()}以下で入力してください。`;
    } else if (hasPrice && hasChange) {
      try {
        const baseline = calculateBaselineFromChange(price, magnitude * changeSign);
        if (baseline > 1e9) error = `基準値が10億${unitName()}を超えています。`;
        else inferredBaseline = baseline;
      } catch {
        error = `基準値は0${unitName()}より大きくしてください。`;
      }
    }
    const visibleError = helperInputs.includes(document.activeElement) ? "" : error;
    helper.price.setAttribute("aria-invalid", String(Boolean(visibleError && hasPrice && (price === null || price < 0 || price > 1e9))));
    helper.change.setAttribute("aria-invalid", String(Boolean(visibleError && hasChange && (magnitude === null || magnitude < 0 || magnitude > 1e9))));
    get("baseline-helper-error").textContent = visibleError;
    const digits = priceDigits();
    get("inferred-baseline").textContent = inferredBaseline === null ? "—"
      : parseNumber(formatNumber(inferredBaseline, digits)) === 0 ? `${money(10 ** -digits)}未満`
      : money(inferredBaseline);
    get("apply-baseline").disabled = inferredBaseline === null;
    updateClearButtons();
  }

  // --- 損益分岐点（米国株・楽天証券） ---------------------------------------
  // 金額はセント単位の整数で扱い、浮動小数の誤差を避ける。
  const toCents = (value) => Math.round(value * 100);
  const centsText = (cents) => `$${new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;

  // 通常口座の売買手数料: 税抜0.45%を1セント未満切り捨て、消費税10%も切り捨て。
  function commissionCents(amountCents) {
    const base = Math.floor(amountCents * RAKUTEN_US.commissionRate + 1e-9);
    const tax = Math.floor(base * RAKUTEN_US.taxRate + 1e-9);
    return base + tax;
  }

  // SEC Fee: 売却代金×料率を1セント未満切り上げ、最低1セント。
  function secFeeCents(amountCents) {
    return Math.max(1, Math.ceil(amountCents * RAKUTEN_US.secFeeRate - 1e-9));
  }

  function sellProfitCents(sellCents, costCents, withCommission) {
    return sellCents - (withCommission ? commissionCents(sellCents) : 0) - secFeeCents(sellCents) - costCents;
  }

  // 損益がプラスになる最小の売却価格（セント）。目安の近くから1セントずつ探す。
  function firstProfitCents(costCents, withCommission) {
    const estimate = withCommission
      ? Math.floor((costCents + 1) / (1 - RAKUTEN_US.commissionRate * (1 + RAKUTEN_US.taxRate)))
      : costCents + 1;
    let cents = Math.max(1, estimate - 3);
    while (sellProfitCents(cents, costCents, withCommission) <= 0) cents += 1;
    return cents;
  }

  function clearBreakeven() {
    for (const cell of document.querySelectorAll(".breakeven-table td")) cell.textContent = "—";
  }

  function updateBreakeven() {
    const hasBuy = breakeven.buy.value.trim() !== "";
    const hasCost = breakeven.cost.value.trim() !== "";
    const buy = parseNumber(breakeven.buy.value);
    const cost = parseNumber(breakeven.cost.value);
    let error = "";
    if ((hasBuy && buy === null) || (hasCost && cost === null)) error = "数字で入力してください。";
    else if (hasBuy && buy <= 0) error = "買付約定価格は0ドルより大きくしてください。";
    else if ((hasBuy && buy > 1e9) || (hasCost && cost > 1e9)) error = "金額は10億ドル以下で入力してください。";
    else if (hasBuy && hasCost && cost < buy) error = "取得単価は買付約定価格以上で入力してください。";
    const visibleError = breakevenInputs.includes(document.activeElement) ? "" : error;
    breakeven.buy.setAttribute("aria-invalid", String(Boolean(visibleError && hasBuy && (buy === null || buy <= 0 || buy > 1e9))));
    breakeven.cost.setAttribute("aria-invalid", String(Boolean(visibleError && hasCost && (cost === null || cost > 1e9 || (buy !== null && cost < buy)))));
    get("breakeven-error").textContent = visibleError;
    updateClearButtons();
    if (!hasBuy || error) {
      clearBreakeven();
      return;
    }
    const buyCents = toCents(buy);
    const fromApp = hasCost;
    const costOn = fromApp ? toCents(cost) : buyCents + commissionCents(buyCents);
    const commissionOn = costOn - buyCents;
    const profitOn = firstProfitCents(costOn, true);
    const profitFree = firstProfitCents(buyCents, false);
    const sellFeeOn = commissionCents(profitOn);
    // 損益分岐点: 手数料・SEC Feeを差し引いて損益が0以下になる最大の価格（利益が出始める1セント手前）。
    const evenOn = profitOn - 1;
    const evenFree = profitFree - 1;
    const set = (id, html) => { get(id).innerHTML = html; };
    set("be-buy-fee-on", centsText(buyCents));
    set("be-buy-free", centsText(buyCents));
    set("be-commission-on", `${centsText(commissionOn)}<small>${fromApp ? "アプリ表示から逆算" : "0.495%・概算"}</small>`);
    set("be-commission-free", "$0");
    set("be-cost-on", centsText(costOn));
    set("be-cost-free", centsText(buyCents));
    set("be-sell-fee-on", `約${centsText(sellFeeOn)}<small>約定代金の0.495%</small>`);
    set("be-sell-fee-free", "$0");
    set("be-sec-on", centsText(secFeeCents(profitOn)));
    set("be-sec-free", centsText(secFeeCents(profitFree)));
    set("be-even-on", centsText(evenOn));
    set("be-even-free", centsText(evenFree));
    set("be-profit-on", `${centsText(profitOn)}以上`);
    set("be-profit-free", `${centsText(profitFree)}以上`);
  }

  function signed(value, digits = 6) {
    const magnitude = formatNumber(Math.abs(value), digits);
    if (magnitude === "0") return "0";
    return `${value < 0 ? "−" : "+"}${magnitude}`;
  }

  function validation(key, value) {
    if (fields[key].value.trim() === "") {
      return { baseline: "前日終値を入力してください。", rate: "騰落率を入力してください。", price: "株価を入力してください。" }[key];
    }
    if (value === null) return "数字で入力してください。";
    if (key === "baseline" && value <= 0) return "前日終値は0より大きい金額にしてください。";
    if (key === "baseline" && value > 1e9) return `前日終値は10億${unitName()}以下で入力してください。`;
    if (key === "price" && value < 0) return `株価は0${unitName()}以上で入力してください。`;
    if (key === "price" && value > 1e9) return `株価は10億${unitName()}以下で入力してください。`;
    if (key === "rate" && value < -100) return "騰落率は−100%以上で入力してください。";
    if (key === "rate" && value > 10000) return "騰落率は10,000%以下で入力してください。";
    return "";
  }

  function setDirection(panel, value) {
    panel.className = `result-panel ${value > 0 ? "is-up" : value < 0 ? "is-down" : "is-flat"}`;
  }

  function clearResult(kind) {
    setDirection(get(`${kind}-panel`), 0);
    get(`${kind}-result-value`).textContent = "—";
    get(`${kind}-delta`).textContent = "—";
    get(`${kind === "percent" ? "rate" : "price"}-badge`).textContent = "入力待ち";
    get(kind === "percent" ? "rounded-price" : "rate-description").textContent = "";
    get(`${kind}-formula`).textContent = "計算に使う値を入力してください。";
  }

  function roundedPriceNote(price) {
    if (market === "us") {
      const cents = Math.round(price * 100) / 100;
      return Math.abs(price - cents) > 1e-9 ? `約 ${money(cents, 2)}（1セント単位）` : "";
    }
    const rounded = Math.round(price);
    return Math.abs(price - rounded) > 1e-7 ? `約 ${money(rounded, 0)}（1円単位）` : "";
  }

  function update() {
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, parseNumber(field.value)]));
    values.rate = values.rate !== null && values.rate >= 0 ? values.rate * rateSign : null;
    get("toggle-sign").textContent = rateSign < 0 ? "−" : "+";
    get("toggle-sign").setAttribute("aria-label", rateSign < 0
      ? "現在マイナス。プラスに切り替え"
      : "現在プラス。マイナスに切り替え");
    const errors = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, validation(key, value)]));
    for (const key of Object.keys(fields)) {
      const visibleError = fields[key].value.trim() && document.activeElement !== fields[key] ? errors[key] : "";
      fields[key].setAttribute("aria-invalid", String(Boolean(visibleError)));
      get(`${key}-error`).textContent = visibleError;
    }
    for (const button of document.querySelectorAll("[data-rate]")) {
      button.setAttribute("aria-pressed", String(!errors.rate && Number(button.dataset.rate) === Math.abs(values.rate)));
    }
    const magnitude = fields.rate.value.trim() === "" ? 0 : parseNumber(fields.rate.value);
    const rateLimit = rateSign < 0 ? 100 : 10000;
    const canStepRate = magnitude !== null && magnitude >= 0 && magnitude <= rateLimit;
    get("rate-up").disabled = !canStepRate || magnitude >= rateLimit;
    get("rate-whole-up").disabled = !canStepRate || magnitude >= rateLimit;
    get("rate-down").disabled = !canStepRate || magnitude <= 0;
    get("rate-whole-down").disabled = !canStepRate || magnitude <= 0;
    const steppingPrice = fields.price.value.trim() === "" ? 0 : values.price;
    const canStepPrice = steppingPrice !== null && steppingPrice >= 0 && steppingPrice <= 1e9;
    for (const id of ["price-up", "price-fine-up"]) get(id).disabled = !canStepPrice || steppingPrice >= 1e9;
    for (const id of ["price-down", "price-fine-down"]) get(id).disabled = !canStepPrice || steppingPrice <= 0;
    updateClearButtons();

    if (errors.baseline || errors.rate) {
      clearResult("percent");
    } else {
      const { price, delta } = calculateFromPercent(values.baseline, values.rate);
      setDirection(get("percent-panel"), delta);
      get("percent-result-value").textContent = formatNumber(price, priceDigits());
      get("rate-badge").textContent = `前日比 ${signed(values.rate)}%`;
      get("percent-delta").textContent = signedMoney(delta);
      get("rounded-price").textContent = roundedPriceNote(price);
      get("percent-formula").textContent = `${formatNumber(values.baseline)} × (1 ${values.rate < 0 ? "−" : "+"} ${formatNumber(Math.abs(values.rate))} ÷ 100)`;
    }

    if (errors.baseline || errors.price) {
      clearResult("price");
    } else {
      const { rate, delta } = calculateFromPrice(values.baseline, values.price);
      setDirection(get("price-panel"), delta);
      get("price-result-value").textContent = signed(rate, 2);
      get("price-badge").textContent = money(values.price);
      get("price-delta").textContent = signedMoney(delta);
      get("rate-description").textContent = delta > 0 ? "前日終値より上昇" : delta < 0 ? "前日終値より下落" : "前日終値と同じ";
      get("price-formula").textContent = `(${formatNumber(values.price)} − ${formatNumber(values.baseline)}) ÷ ${formatNumber(values.baseline)} × 100`;
    }
  }

  function storageStatus() {
    get("storage-status").textContent = storageAvailable
      ? "入力はこのブラウザに保存されます"
      : "このブラウザでは入力を保存できません（計算は利用できます）";
  }

  function save() {
    states[market] = snapshot();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ market, jp: states.jp, us: states.us }));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    storageStatus();
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (isObject(saved)) {
        if (Object.hasOwn(MARKETS, saved.market)) market = saved.market;
        for (const key of Object.keys(MARKETS)) {
          if (isObject(saved[key])) states[key] = readState(saved[key]);
        }
      } else {
        // 市場切替より前の版は日本株のみだったので、その保存値はJPへ引き継ぐ。
        const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
        if (isObject(legacy)) states.jp = readState(legacy);
      }
    } catch {
      // Broken saved JSON is ignored. A storage access error is caught by save().
    }
    restore(states[market]);
  }

  function onInput() {
    normalizeRateInput();
    update();
    save();
  }

  for (const field of inputs) {
    const notifyInput = helperInputs.includes(field) ? onHelperInput : breakevenInputs.includes(field) ? onBreakevenInput : onInput;
    field.addEventListener("focus", () => {
      if (field === fields.baseline) baselineBeforeEdit = parseNumber(field.value);
      if (helperInputs.includes(field)) {
        get("baseline-helper-error").textContent = "";
        for (const helperField of helperInputs) helperField.setAttribute("aria-invalid", "false");
      } else if (breakevenInputs.includes(field)) {
        get("breakeven-error").textContent = "";
        for (const other of breakevenInputs) other.setAttribute("aria-invalid", "false");
      } else {
        get(`${field.id}-error`).textContent = "";
        field.setAttribute("aria-invalid", "false");
      }
      ungroupForEditing(field);
    });
    field.addEventListener("input", (event) => {
      if (!event.isComposing) {
        if (field === fields.baseline) baselineEdited = true;
        ungroupForEditing(field);
        notifyInput();
      }
    });
    field.addEventListener("compositionend", () => {
      if (field === fields.baseline) baselineEdited = true;
      ungroupForEditing(field);
      notifyInput();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        field.blur();
      }
    });
    field.addEventListener("blur", () => {
      if (field === fields.rate) normalizeRateInput();
      if (field === helper.change) changeSign = normalizeMagnitudeInput(field, changeSign);
      const value = parseNumber(field.value);
      if (value !== null) {
        // Group the integer part without rounding the user's decimal digits.
        const normalized = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
        const unsigned = normalized.replace(/^[+-]/, "");
        const [integer, fraction] = unsigned.split(".");
        const integerValue = Number(integer || "0");
        const sign = field === fields.rate || field === helper.change ? "" : value < 0 || /^-/.test(normalized) ? "−" : "";
        const integerText = formatNumber(Math.abs(integerValue), 0);
        field.value = `${sign}${field === fields.rate ? integerText.replaceAll(",", "") : integerText}${fraction !== undefined ? `.${fraction}` : ""}`;
      }
      if (field === fields.baseline) {
        if (baselineEdited && value !== null && value > 0 && value <= 1e9 && value !== baselineBeforeEdit) fields.price.value = field.value;
        baselineEdited = false;
      }
      notifyInput();
    });
  }

  for (const button of document.querySelectorAll("[data-clear]")) {
    const field = get(button.dataset.clear);
    button.addEventListener("pointerdown", (event) => {
      if (document.activeElement === field) event.preventDefault();
    });
    button.addEventListener("click", () => {
      if (field === fields.baseline) {
        baselineEdited = false;
        baselineBeforeEdit = null;
      }
      field.value = "";
      if (helperInputs.includes(field)) onHelperInput();
      else if (breakevenInputs.includes(field)) onBreakevenInput();
      else onInput();
    });
  }

  for (const button of document.querySelectorAll("[data-rate]")) {
    button.addEventListener("click", () => {
      const rate = Number(button.dataset.rate);
      fields.rate.value = String(rate);
      onInput();
    });
  }

  get("toggle-sign").addEventListener("click", () => {
    rateSign *= -1;
    onInput();
  });

  for (const [id, direction, stepTenths] of [
    // Keep the existing ids: single triangles use 1, double triangles use 0.1.
    ["rate-up", 1, 10], ["rate-down", -1, 10],
    ["rate-whole-up", 1, 1], ["rate-whole-down", -1, 1]
  ]) {
    get(id).addEventListener("click", () => {
      const text = fields.rate.value.trim();
      const magnitude = text === "" ? 0 : parseNumber(text);
      const limit = rateSign < 0 ? 100 : 10000;
      if (magnitude === null || magnitude < 0 || magnitude > limit) return;
      const [integer, fraction = ""] = text.split(".");
      const decimalPlaces = Math.max(1, fraction.length);
      // Only the tenths change; retain the remaining digits without floating-point noise.
      const tenths = Number(integer || "0") * 10 + Number(fraction[0] || "0") + direction * stepTenths;
      if (tenths < 0) fields.rate.value = `0.${"0".repeat(decimalPlaces)}`;
      else if (tenths >= limit * 10) fields.rate.value = `${limit}.${"0".repeat(decimalPlaces)}`;
      else fields.rate.value = `${Math.floor(tenths / 10)}.${tenths % 10}${fraction.slice(1)}`;
      onInput();
    });
  }

  // 一重三角は1円/1ドル、二重三角（米株のみ）は1セントで株価を増減する。
  function stepPrice(direction, digits) {
    const value = fields.price.value.trim() === "" ? 0 : parseNumber(fields.price.value);
    if (value === null || value < 0 || value > 1e9) return;
    const text = fields.price.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
    const [integer, fraction] = text.replace(/^[+-]/, "").split(".");
    const scale = 10 ** digits;
    // Only the first `digits` decimals change; the remaining digits are kept as typed.
    const head = (fraction ?? "").slice(0, digits).padEnd(digits, "0");
    const tail = (fraction ?? "").slice(digits);
    const units = Number(integer || "0") * scale + Number(head || "0") + direction;
    const maxUnits = 1e9 * scale;
    const clamped = units < 0 || units >= maxUnits;
    const bounded = Math.max(0, Math.min(maxUnits, units));
    const integerPart = Math.floor(bounded / scale);
    const integerText = document.activeElement === fields.price ? String(integerPart) : formatNumber(integerPart, 0);
    let fractionText = "";
    if (digits === 0) fractionText = !clamped && fraction !== undefined ? `.${fraction}` : "";
    else if (!clamped) fractionText = `.${String(bounded % scale).padStart(digits, "0")}${tail}`;
    fields.price.value = `${integerText}${fractionText}`;
    onInput();
  }

  get("price-up").addEventListener("click", () => stepPrice(1, 0));
  get("price-down").addEventListener("click", () => stepPrice(-1, 0));
  get("price-fine-up").addEventListener("click", () => { if (MARKETS[market].fineDigits !== null) stepPrice(1, MARKETS[market].fineDigits); });
  get("price-fine-down").addEventListener("click", () => { if (MARKETS[market].fineDigits !== null) stepPrice(-1, MARKETS[market].fineDigits); });

  function onHelperInput() {
    updateBaselineHelper();
    save();
  }

  function onBreakevenInput() {
    updateBreakeven();
    save();
  }

  get("change-sign").addEventListener("click", () => {
    changeSign *= -1;
    onHelperInput();
  });

  get("apply-baseline").addEventListener("click", () => {
    updateBaselineHelper();
    if (inferredBaseline === null) return;
    baselineEdited = false;
    baselineBeforeEdit = null;
    fields.baseline.value = baselineInputValue(inferredBaseline);
    fields.price.value = fields.baseline.value;
    onInput();
    get("baseline-helper").open = false;
    get("baseline-helper").querySelector("summary").focus({ preventScroll: true });
  });

  for (const button of document.querySelectorAll("[data-market-select]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.marketSelect;
      if (next === market || !Object.hasOwn(MARKETS, next)) return;
      // 入力値は市場ごとに持つ。切替前の値を退避し、切替先の値を戻す。
      states[market] = snapshot();
      market = next;
      restore(states[market]);
      baselineEdited = false;
      baselineBeforeEdit = null;
      applyMarket();
      normalizeRateInput();
      updateBaselineHelper();
      updateBreakeven();
      update();
      save();
    });
  }

  get("reset").addEventListener("click", () => {
    baselineEdited = false;
    baselineBeforeEdit = null;
    rateSign = 1;
    changeSign = 1;
    helper.price.value = "";
    helper.change.value = "";
    updateBaselineHelper();
    breakeven.buy.value = "";
    breakeven.cost.value = "";
    updateBreakeven();
    for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
    onInput();
  });

  load();
  applyMarket();
  normalizeRateInput();
  updateBaselineHelper();
  updateBreakeven();
  update();
  save();
})();
