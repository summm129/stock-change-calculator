(() => {
  "use strict";

  const { parseNumber, calculateFromPercent, calculateFromPrice, formatNumber } = StockCalculator;
  const STORAGE_KEY = "stock-change-calculator:v1";
  const defaults = { baseline: "2,430", rate: "+7", price: "2,637" };
  const fields = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.getElementById(key)]));
  const get = (id) => document.getElementById(id);
  let storageAvailable = true;

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

  function clearResult(kind, message) {
    setDirection(get(`${kind}-panel`), 0);
    get(`${kind}-result-value`).textContent = "—";
    get(`${kind}-delta`).textContent = "—";
    get(`${kind === "percent" ? "rate" : "price"}-badge`).textContent = "入力待ち";
    get(kind === "percent" ? "rounded-price" : "rate-description").textContent = message;
    get(`${kind}-formula`).textContent = "計算に使う値を入力してください。";
  }

  function update() {
    const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, parseNumber(field.value)]));
    const errors = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, validation(key, value)]));
    for (const key of Object.keys(fields)) {
      fields[key].setAttribute("aria-invalid", String(Boolean(errors[key])));
      get(`${key}-error`).textContent = errors[key];
    }
    for (const button of document.querySelectorAll("[data-rate]")) {
      button.setAttribute("aria-pressed", String(!errors.rate && Number(button.dataset.rate) === values.rate));
    }

    if (errors.baseline || errors.rate) {
      clearResult("percent", errors.baseline || errors.rate);
    } else {
      const { price, delta } = calculateFromPercent(values.baseline, values.rate);
      setDirection(get("percent-panel"), delta);
      get("percent-result-value").textContent = formatNumber(price);
      get("rate-badge").textContent = `前日比 ${signed(values.rate)}%`;
      get("percent-delta").textContent = `${signed(delta)}円`;
      const rounded = Math.round(price);
      const approximate = Math.abs(price - rounded) > 1e-7;
      get("rounded-price").textContent = `1円単位なら ${approximate ? "約 " : ""}${formatNumber(rounded, 0)}円`;
      get("percent-formula").textContent = `${formatNumber(values.baseline)} × (1 ${values.rate < 0 ? "−" : "+"} ${formatNumber(Math.abs(values.rate))} ÷ 100)`;
    }

    if (errors.baseline || errors.price) {
      clearResult("price", errors.baseline || errors.price);
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
          if (typeof saved[key] === "string" && saved[key].length <= 24) fields[key].value = saved[key];
        }
      }
    } catch {
      // Broken saved JSON is ignored. A storage access error is caught by save().
    }
  }

  function onInput() {
    update();
    save();
  }

  for (const field of Object.values(fields)) {
    field.addEventListener("input", (event) => {
      if (!event.isComposing) onInput();
    });
    field.addEventListener("compositionend", onInput);
    field.addEventListener("blur", () => {
      const value = parseNumber(field.value);
      if (value !== null) {
        // Group the integer part without rounding the user's decimal digits.
        const normalized = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
        const unsigned = normalized.replace(/^[+-]/, "");
        const [integer, fraction] = unsigned.split(".");
        const integerValue = Number(integer || "0");
        const sign = value < 0 || /^-/.test(normalized) ? "−" : field === fields.rate && value > 0 ? "+" : "";
        field.value = `${sign}${formatNumber(Math.abs(integerValue), 0)}${fraction !== undefined ? `.${fraction}` : ""}`;
        onInput();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-rate]")) {
    button.addEventListener("click", () => {
      const rate = Number(button.dataset.rate);
      fields.rate.value = rate > 0 ? `+${rate}` : String(rate);
      onInput();
    });
  }

  get("toggle-sign").addEventListener("click", () => {
    const rate = parseNumber(fields.rate.value);
    if (rate !== null) {
      const digits = fields.rate.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").trim().replace(/^[+-]/, "");
      fields.rate.value = `${rate < 0 ? "+" : "−"}${digits}`;
    } else {
      fields.rate.value = "−";
    }
    onInput();
    fields.rate.focus();
  });

  get("reset").addEventListener("click", () => {
    for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
    onInput();
    fields.baseline.focus();
  });

  load();
  update();
  save();
})();
