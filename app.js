(() => {
  "use strict";

  const { parseNumber, calculateFromPercent, calculateFromPrice, calculateBaselineFromChange, formatNumber } = StockCalculator;
  const STORAGE_KEY = "stock-change-calculator:v1";
  const defaults = { baseline: "", rate: "", price: "" };
  const fields = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.getElementById(key)]));
  const get = (id) => document.getElementById(id);
  const helper = { price: get("current-price"), change: get("price-change") };
  const helperInputs = Object.values(helper);
  const inputs = [...Object.values(fields), ...helperInputs];
  let storageAvailable = true;
  let rateSign = 1;
  let changeSign = 1;
  let inferredBaseline = null;

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
      error = "現在値は0円以上で入力してください。";
    } else if ((hasPrice && price > 1e9) || (hasChange && magnitude > 1e9)) {
      error = "金額は10億円以下で入力してください。";
    } else if (hasPrice && hasChange) {
      try {
        const baseline = calculateBaselineFromChange(price, magnitude * changeSign);
        if (baseline > 1e9) error = "基準値が10億円を超えています。";
        else inferredBaseline = baseline;
      } catch {
        error = "基準値は0円より大きくしてください。";
      }
    }
    const visibleError = helperInputs.includes(document.activeElement) ? "" : error;
    helper.price.setAttribute("aria-invalid", String(Boolean(visibleError && hasPrice && (price === null || price < 0 || price > 1e9))));
    helper.change.setAttribute("aria-invalid", String(Boolean(visibleError && hasChange && (magnitude === null || magnitude < 0 || magnitude > 1e9))));
    get("baseline-helper-error").textContent = visibleError;
    get("inferred-baseline").textContent = inferredBaseline === null ? "—"
      : parseNumber(formatNumber(inferredBaseline)) === 0 ? "0.000001円未満"
      : `${formatNumber(inferredBaseline)}円`;
    get("apply-baseline").disabled = inferredBaseline === null;
    updateClearButtons();
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
    if (key === "baseline" && value > 1e9) return "前日終値は10億円以下で入力してください。";
    if (key === "price" && value < 0) return "株価は0円以上で入力してください。";
    if (key === "price" && value > 1e9) return "株価は10億円以下で入力してください。";
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
    get("price-up").disabled = !canStepPrice || steppingPrice >= 1e9;
    get("price-down").disabled = !canStepPrice || steppingPrice <= 0;
    updateClearButtons();

    if (errors.baseline || errors.rate) {
      clearResult("percent");
    } else {
      const { price, delta } = calculateFromPercent(values.baseline, values.rate);
      setDirection(get("percent-panel"), delta);
      get("percent-result-value").textContent = formatNumber(price);
      get("rate-badge").textContent = `前日比 ${signed(values.rate)}%`;
      get("percent-delta").textContent = `${signed(delta)}円`;
      const rounded = Math.round(price);
      const approximate = Math.abs(price - rounded) > 1e-7;
      get("rounded-price").textContent = approximate ? `約 ${formatNumber(rounded, 0)}円（1円単位）` : "";
      get("percent-formula").textContent = `${formatNumber(values.baseline)} × (1 ${values.rate < 0 ? "−" : "+"} ${formatNumber(Math.abs(values.rate))} ÷ 100)`;
    }

    if (errors.baseline || errors.price) {
      clearResult("price");
    } else {
      const { rate, delta } = calculateFromPrice(values.baseline, values.price);
      setDirection(get("price-panel"), delta);
      get("price-result-value").textContent = signed(rate, 2);
      get("price-badge").textContent = `${formatNumber(values.price)}円`;
      get("price-delta").textContent = `${signed(delta)}円`;
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
    try {
      const state = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
      state.rateSign = rateSign;
      state.currentPrice = helper.price.value;
      state.priceChange = helper.change.value;
      state.changeSign = changeSign;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    storageStatus();
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const key of Object.keys(fields)) {
          // Computed values can have more digits than a typed value.
          const maxLength = key === "baseline" ? 350 : key === "price" ? 40 : 32;
          if (typeof saved[key] === "string" && saved[key].length <= maxLength) fields[key].value = saved[key];
        }
        if (saved.rateSign === -1 || saved.rateSign === 1) rateSign = saved.rateSign;
        if (typeof saved.currentPrice === "string" && saved.currentPrice.length <= 32) helper.price.value = saved.currentPrice;
        if (typeof saved.priceChange === "string" && saved.priceChange.length <= 32) helper.change.value = saved.priceChange;
        if (saved.changeSign === -1 || saved.changeSign === 1) changeSign = saved.changeSign;
      }
    } catch {
      // Broken saved JSON is ignored. A storage access error is caught by save().
    }
  }

  function onInput() {
    normalizeRateInput();
    update();
    save();
  }

  for (const field of inputs) {
    const notifyInput = helperInputs.includes(field) ? onHelperInput : onInput;
    field.addEventListener("focus", () => {
      if (helperInputs.includes(field)) {
        get("baseline-helper-error").textContent = "";
        for (const helperField of helperInputs) helperField.setAttribute("aria-invalid", "false");
      } else {
        get(`${field.id}-error`).textContent = "";
        field.setAttribute("aria-invalid", "false");
      }
      ungroupForEditing(field);
    });
    field.addEventListener("input", (event) => {
      if (!event.isComposing) {
        ungroupForEditing(field);
        notifyInput();
      }
    });
    field.addEventListener("compositionend", () => {
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
      notifyInput();
    });
  }

  for (const button of document.querySelectorAll("[data-clear]")) {
    const field = get(button.dataset.clear);
    button.addEventListener("pointerdown", (event) => {
      if (document.activeElement === field) event.preventDefault();
    });
    button.addEventListener("click", () => {
      field.value = "";
      if (helperInputs.includes(field)) onHelperInput();
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
    ["rate-up", 1, 1], ["rate-down", -1, 1],
    ["rate-whole-up", 1, 10], ["rate-whole-down", -1, 10]
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

  for (const [id, direction] of [["price-up", 1], ["price-down", -1]]) {
    get(id).addEventListener("click", () => {
      const value = fields.price.value.trim() === "" ? 0 : parseNumber(fields.price.value);
      if (value === null || value < 0 || value > 1e9) return;
      const text = fields.price.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
      const [integer, fraction] = text.replace(/^[+-]/, "").split(".");
      const next = Number(integer || "0") + direction;
      const clamped = next < 0 || next >= 1e9;
      const bounded = Math.max(0, Math.min(1e9, next));
      const integerText = document.activeElement === fields.price ? String(bounded) : formatNumber(bounded, 0);
      fields.price.value = `${integerText}${!clamped && fraction !== undefined ? `.${fraction}` : ""}`;
      onInput();
    });
  }

  function onHelperInput() {
    updateBaselineHelper();
    save();
  }

  get("change-sign").addEventListener("click", () => {
    changeSign *= -1;
    onHelperInput();
  });

  get("apply-baseline").addEventListener("click", () => {
    updateBaselineHelper();
    if (inferredBaseline === null) return;
    fields.baseline.value = baselineInputValue(inferredBaseline);
    fields.price.value = helper.price.value;
    onInput();
    get("baseline-helper").open = false;
    get("baseline-helper").querySelector("summary").focus({ preventScroll: true });
  });

  get("reset").addEventListener("click", () => {
    rateSign = 1;
    changeSign = 1;
    helper.price.value = "";
    helper.change.value = "";
    updateBaselineHelper();
    for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
    onInput();
  });

  load();
  normalizeRateInput();
  updateBaselineHelper();
  update();
  save();
})();
