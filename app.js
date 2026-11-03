(() => {
  "use strict";

  const { parseNumber, calculateFromPercent, calculateFromPrice, formatNumber } = StockCalculator;
  const STORAGE_KEY = "stock-change-calculator:v2";
  // 見た目の設定は入力値と分けて保存する。index.html の先頭でも同じキーを読んでちらつきを防ぐ。
  const SETTINGS_KEY = "stock-change-calculator:settings";
  // お気に入り銘柄。各銘柄が自分の入力値（前日終値など）を持つ。active は市場ごとに選んでいる銘柄
  const FAVORITES_KEY = "stock-change-calculator:favorites";
  const SETTING_VALUES = { theme: ["light", "dark"], layout: ["scroll", "tabs"], account: ["tokutei", "nisa"], keypad: ["standard", "simeji"] };
  const THEME_COLORS = { light: "#f4f3f1", dark: "#141414" };
  const LEGACY_STORAGE_KEY = "stock-change-calculator:v1";
  // 市場ごとの表示設定。JPは円を後置・6桁、USはドル記号を前置・4桁。率はどちらも2桁。
  const MARKETS = {
    jp: { unit: "円", symbol: "円", priceDigits: 6, fineDigits: null, fineLabel: "" },
    us: { unit: "ドル", symbol: "$", priceDigits: 4, fineDigits: 2, fineLabel: "1セント" }
  };
  // 楽天証券・米国株の手数料（2026-11時点）。通常口座は税抜0.45%＋消費税10%（税込0.495%）、上限は税込22ドル
  // （約定代金4,444.45ドル以上で上限）。NISAは無料。SEC Feeは売却代金×0.0000206ドル（2026-04-02公表の料率）、最低1セント。
  const RAKUTEN_US = { commissionRate: 0.0045, taxRate: 0.1, capCents: 2200, secFeeRate: 0.0000206 };
  const defaults = { baseline: "", rate: "", price: "" };
  const fields = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.getElementById(key)]));
  const get = (id) => document.getElementById(id);
  // 保有（買値・株数）。損益の表示と、米国株の 03 の買付約定価格に使う
  const hold = { buy: get("hold-buy"), qty: get("hold-qty") };
  const holdInputs = Object.values(hold);
  const breakeven = { cost: get("cost-basis") };
  const breakevenInputs = Object.values(breakeven);
  const inputs = [...Object.values(fields), ...holdInputs, ...breakevenInputs];
  let storageAvailable = true;
  let market = "jp";
  let rateSign = 1;
  const states = { jp: emptyState(), us: emptyState() };
  const settings = { theme: "light", layout: "scroll", account: "tokutei", keypad: "standard" };
  let favorites = [];
  const activeFav = { jp: null, us: null };
  let account = "tokutei";
  let activeTab = "percent";

  function emptyState() {
    return { baseline: "", rate: "", price: "", rateSign: 1, holdBuy: "", holdQty: "", costBasis: "" };
  }

  function snapshot() {
    return {
      baseline: fields.baseline.value,
      rate: fields.rate.value,
      price: fields.price.value,
      rateSign,
      holdBuy: hold.buy.value,
      holdQty: hold.qty.value,
      costBasis: breakeven.cost.value
    };
  }

  function restore(state) {
    fields.baseline.value = state.baseline;
    fields.rate.value = state.rate;
    fields.price.value = state.price;
    rateSign = state.rateSign;
    hold.buy.value = state.holdBuy;
    hold.qty.value = state.holdQty;
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
    if (typeof saved.holdBuy === "string" && saved.holdBuy.length <= 32) state.holdBuy = saved.holdBuy;
    // 以前の版で 03 に入れていた買付約定価格は、保有の買値として引き継ぐ
    else if (typeof saved.buyPrice === "string" && saved.buyPrice.length <= 32) state.holdBuy = saved.buyPrice;
    if (typeof saved.holdQty === "string" && saved.holdQty.length <= 24) state.holdQty = saved.holdQty;
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
    get("tab-breakeven").hidden = market !== "us";
    if (market !== "us" && activeTab === "breakeven") activeTab = "percent";
    applyTabs();
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

  // 入力欄の×は値があるときだけ出す。米株は $ を数字の隣に置くため、入力欄の幅を中身に合わせる。
  const sizer = document.createElement("span");
  sizer.setAttribute("aria-hidden", "true");
  sizer.style.cssText = "position: absolute; visibility: hidden; white-space: pre; left: -9999px; top: 0";
  document.body.append(sizer);

  function fitInputWidth(input) {
    if (market !== "us" || !input.parentElement.querySelector(".input-unit")) {
      input.style.removeProperty("width");
      return;
    }
    const style = getComputedStyle(input);
    for (const key of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariantNumeric", "letterSpacing"]) sizer.style[key] = style[key];
    sizer.textContent = input.value || "0";
    // 余白はキャレットの分だけ
    input.style.width = `${Math.ceil(sizer.getBoundingClientRect().width) + 3}px`;
  }

  function updateClearButtons() {
    for (const button of document.querySelectorAll("[data-clear]")) {
      const input = get(button.dataset.clear);
      button.hidden = input.value.trim() === "";
      fitInputWidth(input);
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

  // ---- 保有（買値・株数） ----
  function holdValues() {
    const buy = parseNumber(hold.buy.value);
    const qty = parseNumber(hold.qty.value);
    return {
      buy: buy !== null && buy > 0 && buy <= 1e9 ? buy : null,
      qty: qty !== null && qty > 0 && qty <= 1e9 ? qty : null
    };
  }

  function updateHolding() {
    const hasBuy = hold.buy.value.trim() !== "";
    const hasQty = hold.qty.value.trim() !== "";
    const buy = parseNumber(hold.buy.value);
    const qty = parseNumber(hold.qty.value);
    const badBuy = hasBuy && (buy === null || buy <= 0 || buy > 1e9);
    const badQty = hasQty && (qty === null || qty <= 0 || qty > 1e9);
    let error = "";
    if (badBuy) error = buy === null ? "買値は数字で入力してください。" : `買値は0より大きく、10億${unitName()}以下で入力してください。`;
    else if (badQty) error = qty === null ? "株数は数字で入力してください。" : "株数は0より大きい数で入力してください。";
    const visible = holdInputs.includes(document.activeElement) ? "" : error;
    hold.buy.setAttribute("aria-invalid", String(Boolean(visible && badBuy)));
    hold.qty.setAttribute("aria-invalid", String(Boolean(visible && badQty)));
    get("hold-error").textContent = visible;
    updateClearButtons();
  }

  // 01/02 の株価に対して、買値からの率と損益（株数があれば）を出す
  function renderPnl(kind, price) {
    const box = get(`${kind}-pnl`);
    const { buy, qty } = holdValues();
    if (buy === null || price === null) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const rate = (price / buy - 1) * 100;
    const gain = qty === null ? null : (price - buy) * qty;
    const direction = gain !== null ? gain : rate;
    box.classList.toggle("is-up", direction > 0 && Math.abs(direction) > 1e-9);
    box.classList.toggle("is-down", direction < 0 && Math.abs(direction) > 1e-9);
    get(`${kind}-pnl-rate`).textContent = `${signed(rate, 2)}%`;
    get(`${kind}-pnl-gain-row`).hidden = gain === null;
    if (gain !== null) {
      get(`${kind}-pnl-label`).textContent = `損益（${formatNumber(qty, 4)}株）`;
      get(`${kind}-pnl-gain`).textContent = signedMoney(gain);
    }
    get(`${kind}-pnl-note`).textContent = gain !== null && market === "us" ? "手数料を引く前" : "";
  }

  // --- 損益分岐点（米国株・楽天証券） ---------------------------------------
  // 金額はセント単位の整数で扱い、浮動小数の誤差を避ける。
  const toCents = (value) => Math.round(value * 100);
  const centsText = (cents) => `$${new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;

  // 通常口座の買付手数料: 税抜0.45%を1セント未満切り捨て、消費税10%も切り捨て（アプリの取得単価と一致）。
  function commissionCents(amountCents) {
    const base = Math.floor(amountCents * RAKUTEN_US.commissionRate + 1e-9);
    const tax = Math.floor(base * RAKUTEN_US.taxRate + 1e-9);
    return Math.min(base + tax, RAKUTEN_US.capCents);
  }

  // 通常口座の売却手数料: 税込0.495%を1セント単位に四捨五入。
  function sellCommissionCents(amountCents) {
    return Math.min(Math.round(amountCents * RAKUTEN_US.commissionRate * (1 + RAKUTEN_US.taxRate) + 1e-9), RAKUTEN_US.capCents);
  }

  // SEC Fee: 売却代金×料率を1セント未満切り上げ、最低1セント。
  function secFeeCents(amountCents) {
    return Math.max(1, Math.ceil(amountCents * RAKUTEN_US.secFeeRate - 1e-9));
  }

  function sellProfitCents(sellCents, costCents, withCommission) {
    return sellCents - (withCommission ? sellCommissionCents(sellCents) : 0) - secFeeCents(sellCents) - costCents;
  }

  // 損益がプラスになる最小の売却価格（セント）。売却価格が上がるほど損益は増えるので二分探索で求める。
  // 手数料に上限があるため、率だけの近似式からは探さない。
  function firstProfitCents(costCents, withCommission) {
    let low = 1;
    let high = costCents * 2 + 10000;
    while (sellProfitCents(high, costCents, withCommission) <= 0) high *= 2;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (sellProfitCents(mid, costCents, withCommission) > 0) high = mid;
      else low = mid + 1;
    }
    return low;
  }

  const BREAKEVEN_CELLS = ["be-profit", "be-fee-total", "be-fee-buy", "be-fee-sell", "be-fee-sec", "be-cost", "be-even"];

  function clearBreakeven() {
    for (const id of BREAKEVEN_CELLS) get(id).textContent = "—";
  }

  function applyAccount() {
    for (const button of document.querySelectorAll("[data-account]")) {
      button.setAttribute("aria-pressed", String(button.dataset.account === account));
    }
  }

  function updateBreakeven() {
    applyAccount();
    const { buy } = holdValues();
    const hasBuy = buy !== null;
    const hasCost = breakeven.cost.value.trim() !== "";
    const cost = parseNumber(breakeven.cost.value);
    get("be-buy-display").textContent = hasBuy ? centsText(toCents(buy)) : "—";
    get("be-need-buy").hidden = hasBuy;
    let error = "";
    if (hasCost && cost === null) error = "取得単価は数字で入力してください。";
    else if (hasCost && cost > 1e9) error = "取得単価は10億ドル以下で入力してください。";
    else if (hasBuy && hasCost && cost < buy) error = "取得単価は保有の買値以上で入力してください。";
    const visibleError = breakevenInputs.includes(document.activeElement) ? "" : error;
    breakeven.cost.setAttribute("aria-invalid", String(Boolean(visibleError)));
    // 取得単価の欄が閉じていてもエラーに気づけるよう、問題があれば開く
    if (visibleError && hasCost && breakeven.cost.getAttribute("aria-invalid") === "true") setCostPanel(true);
    get("breakeven-error").textContent = visibleError;
    updateClearButtons();
    if (!hasBuy || error) {
      clearBreakeven();
      return;
    }
    const buyCents = toCents(buy);
    const set = (id, cents) => { get(id).textContent = centsText(cents); };
    if (account === "tokutei") {
      // 取得単価があれば、約定価格との差を実際の買付手数料として使う
      const cost = hasCost ? toCents(parseNumber(breakeven.cost.value)) : buyCents + commissionCents(buyCents);
      const buyFee = cost - buyCents;
      const profit = firstProfitCents(cost, true);
      const sellFee = sellCommissionCents(profit);
      const secFee = secFeeCents(profit);
      set("be-profit", profit);
      set("be-fee-total", buyFee + sellFee + secFee);
      set("be-fee-buy", buyFee);
      set("be-fee-sell", sellFee);
      set("be-fee-sec", secFee);
      set("be-cost", cost);
      // 損益分岐点: 手数料・SEC Feeを差し引いて損益が0以下になる最大の価格（利益が出始める1セント手前）
      set("be-even", profit - 1);
    } else {
      const profit = firstProfitCents(buyCents, false);
      const secFee = secFeeCents(profit);
      set("be-profit", profit);
      set("be-fee-total", secFee);
      set("be-fee-buy", 0);
      set("be-fee-sell", 0);
      set("be-fee-sec", secFee);
      set("be-cost", buyCents);
      set("be-even", profit - 1);
    }
  }

  function setCostPanel(open) {
    get("cost-panel").hidden = !open;
    get("cost-toggle").setAttribute("aria-expanded", String(open));
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
    get("set-baseline-price").disabled = Boolean(errors.baseline);
    updateClearButtons();

    if (errors.baseline || errors.rate) {
      clearResult("percent");
      renderPnl("percent", null);
    } else {
      const { price, delta } = calculateFromPercent(values.baseline, values.rate);
      setDirection(get("percent-panel"), delta);
      get("percent-result-value").textContent = formatNumber(price, priceDigits());
      get("rate-badge").textContent = `前日比 ${signed(values.rate)}%`;
      get("percent-delta").textContent = signedMoney(delta);
      get("rounded-price").textContent = roundedPriceNote(price);
      get("percent-formula").textContent = `${formatNumber(values.baseline)} × (1 ${values.rate < 0 ? "−" : "+"} ${formatNumber(Math.abs(values.rate))} ÷ 100)`;
      renderPnl("percent", price);
    }

    // 02 の損益は前日終値がなくても、株価と買値があれば出す
    renderPnl("price", errors.price ? null : values.price);
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
      ? ""
      : "このブラウザでは入力を保存できません（計算は利用できます）";
  }

  function save() {
    storeCurrent();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ market, jp: states.jp, us: states.us }));
      localStorage.setItem(FAVORITES_KEY, JSON.stringify({ list: favorites, active: activeFav }));
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
    loadFavorites();
    restore(currentState());
  }

  function onInput() {
    normalizeRateInput();
    update();
    save();
  }

  for (const field of inputs) {
    const notifyInput = holdInputs.includes(field) ? onHoldInput : breakevenInputs.includes(field) ? onBreakevenInput : onInput;
    field.addEventListener("focus", () => {
      if (holdInputs.includes(field)) {
        get("hold-error").textContent = "";
        for (const other of holdInputs) other.setAttribute("aria-invalid", "false");
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
      const value = parseNumber(field.value);
      if (value !== null) {
        // Group the integer part without rounding the user's decimal digits.
        const normalized = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
        const unsigned = normalized.replace(/^[+-]/, "");
        const [integer, fraction] = unsigned.split(".");
        const integerValue = Number(integer || "0");
        const sign = field === fields.rate ? "" : value < 0 || /^-/.test(normalized) ? "−" : "";
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
      if (breakevenInputs.includes(field)) onBreakevenInput();
      else if (holdInputs.includes(field)) onHoldInput();
      else onInput();
    });
  }

  // 米株では入力欄が数字の幅だけになるので、欄のどこを押しても入力できるようにする
  for (const box of document.querySelectorAll(".field")) {
    const input = box.querySelector("input");
    if (!input) continue;
    box.addEventListener("click", (event) => {
      if (event.target === box || event.target.classList.contains("input-unit") || event.target.classList.contains("field-suffix")) input.focus();
    });
  }
  if (document.fonts) document.fonts.ready.then(updateClearButtons);

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

  for (const [id, direction, stepHundredths] of [
    // Keep the existing ids: single triangles use 1, double triangles use 0.01.
    ["rate-up", 1, 100], ["rate-down", -1, 100],
    ["rate-whole-up", 1, 1], ["rate-whole-down", -1, 1]
  ]) {
    get(id).addEventListener("click", () => {
      const text = fields.rate.value.trim();
      const magnitude = text === "" ? 0 : parseNumber(text);
      const limit = rateSign < 0 ? 100 : 10000;
      if (magnitude === null || magnitude < 0 || magnitude > limit) return;
      const [integer, fraction = ""] = text.split(".");
      const decimalPlaces = Math.max(2, fraction.length);
      // Only the hundredths change; retain the remaining digits without floating-point noise.
      const hundredths = Number(integer || "0") * 100 + Number(fraction.slice(0, 2).padEnd(2, "0")) + direction * stepHundredths;
      if (hundredths < 0) fields.rate.value = `0.${"0".repeat(decimalPlaces)}`;
      else if (hundredths >= limit * 100) fields.rate.value = `${limit}.${"0".repeat(decimalPlaces)}`;
      else fields.rate.value = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}${fraction.slice(2)}`;
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

  get("set-baseline-price").addEventListener("click", () => {
    if (validation("baseline", parseNumber(fields.baseline.value))) return;
    fields.price.value = fields.baseline.value;
    onInput();
  });

  get("price-up").addEventListener("click", () => stepPrice(1, 0));
  get("price-down").addEventListener("click", () => stepPrice(-1, 0));
  get("price-fine-up").addEventListener("click", () => { if (MARKETS[market].fineDigits !== null) stepPrice(1, MARKETS[market].fineDigits); });
  get("price-fine-down").addEventListener("click", () => { if (MARKETS[market].fineDigits !== null) stepPrice(-1, MARKETS[market].fineDigits); });

  function onHoldInput() {
    updateHolding();
    update();
    updateBreakeven();
    save();
  }

  function onBreakevenInput() {
    updateBreakeven();
    save();
  }

  for (const button of document.querySelectorAll("[data-market-select]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.marketSelect;
      if (next === market || !Object.hasOwn(MARKETS, next)) return;
      // 入力値は市場ごとに持つ。切替前の値を退避し、切替先の値を戻す。
      storeCurrent();
      market = next;
      restore(currentState());
      applyMarket();
      refreshAfterRestore();
    });
  }

  function resetInputs() {
    rateSign = 1;
    hold.buy.value = "";
    hold.qty.value = "";
    updateHolding();
    breakeven.cost.value = "";
    updateBreakeven();
    for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
    onInput();
  }

  get("reset").addEventListener("click", resetInputs);
  get("settings-reset").addEventListener("click", () => {
    resetInputs();
    get("settings-reset").blur();
    get("storage-status").textContent = storageAvailable ? "" : get("storage-status").textContent;
  });

  // ---- 03 の口座スイッチと取得単価の訂正欄 ----
  for (const button of document.querySelectorAll("[data-account]")) {
    button.addEventListener("click", () => {
      account = button.dataset.account;
      updateBreakeven();
    });
  }
  get("cost-toggle").addEventListener("click", () => {
    const open = get("cost-panel").hidden;
    setCostPanel(open);
    if (open) breakeven.cost.focus({ preventScroll: true });
  });

  // ---- タブ表示 ----
  function applyTabs() {
    for (const tab of document.querySelectorAll("[data-tab]")) {
      const active = tab.dataset.tab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-panel]")) {
      panel.classList.toggle("is-active", panel.dataset.panel === activeTab);
    }
  }
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      applyTabs();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const visible = tabs.filter((t) => !t.hidden);
      const next = visible[(visible.indexOf(tab) + (event.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length];
      activeTab = next.dataset.tab;
      applyTabs();
      next.focus();
    });
  }

  // ---- 設定（テーマ・画面の作り・最初に表示する口座・テンキー） ----
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (isObject(saved)) {
        for (const [key, values] of Object.entries(SETTING_VALUES)) {
          if (values.includes(saved[key])) settings[key] = saved[key];
        }
      }
    } catch {
      // 読めない設定は既定値で動かす
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // 保存できなくても、この画面では設定が効く
    }
  }

  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.layout = settings.layout;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", THEME_COLORS[settings.theme]);
    // Simeji 用の対応: Simeji は inputmode="decimal" だと「.」のないテンキーを出し、電話番号の欄（type="tel"）だと「.」つきを出す。
    // Galaxy のキーボードなどは逆なので、既定は decimal のままにして設定でだけ切り替える。
    for (const input of inputs) {
      if (settings.keypad === "simeji") {
        input.removeAttribute("inputmode");
        input.type = "tel";
      } else {
        input.type = "text";
        input.setAttribute("inputmode", "decimal");
      }
    }
    for (const control of document.querySelectorAll("[data-setting]")) {
      const on = settings[control.dataset.setting] === control.dataset.value;
      control.setAttribute(control.getAttribute("role") === "radio" ? "aria-checked" : "aria-pressed", String(on));
    }
  }

  for (const control of document.querySelectorAll("[data-setting]")) {
    control.addEventListener("click", () => {
      const key = control.dataset.setting;
      settings[key] = control.dataset.value;
      if (key === "account") {
        account = settings.account;
        updateBreakeven();
      }
      applySettings();
      saveSettings();
    });
  }

  // ---- 画面の切り替え（計算・設定・お気に入りの編集）とシート。端末の戻る操作でも戻れる ----
  const VIEWS = { main: "main-view", settings: "settings-view", favorites: "favorites-view" };
  const VIEW_FOCUS = { settings: "settings-title", favorites: "favorites-title" };
  let currentView = "main";
  let mainScroll = 0;
  let sheetReturnFocus = null;

  function showView(view) {
    if (view === currentView) return;
    if (currentView === "main") mainScroll = window.scrollY;
    for (const [name, id] of Object.entries(VIEWS)) get(id).hidden = name !== view;
    const from = currentView;
    currentView = view;
    if (view === "main") {
      window.scrollTo(0, mainScroll);
      get(from === "favorites" ? "open-favorites" : "open-settings").focus({ preventScroll: true });
    } else {
      window.scrollTo(0, 0);
      get(VIEW_FOCUS[view]).focus({ preventScroll: true });
    }
  }

  function openView(view) {
    history.pushState({ view }, "");
    showView(view);
  }

  function closeView() {
    if (history.state && history.state.view) history.back();
    else showView("main");
  }

  get("open-settings").addEventListener("click", () => openView("settings"));
  get("close-settings").addEventListener("click", closeView);
  get("open-favorites").addEventListener("click", () => openView("favorites"));
  get("close-favorites").addEventListener("click", closeView);

  window.addEventListener("popstate", () => {
    const state = history.state || {};
    showSheet(Boolean(state.sheet));
    showView(state.view || "main");
  });

  // ---- お気に入り銘柄 ----
  const FAV_CODE_RULES = {
    jp: { label: "証券コード", pattern: /^[0-9][0-9A-Z]{3}$/, example: "4桁（例: 7203、130A）" },
    us: { label: "ティッカー", pattern: /^[A-Z][A-Z0-9.\-]{0,9}$/, example: "英字（例: INTC、BRK.B）" }
  };
  const MARKET_NAMES = { jp: "日本株", us: "米国株" };
  let sheetFavId = null;
  let sheetMarket = "jp";

  function loadFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY));
      if (!isObject(saved) || !Array.isArray(saved.list)) return;
      favorites = saved.list.filter((f) => isObject(f) && typeof f.id === "string" && Object.hasOwn(MARKETS, f.market))
        .slice(0, 100)
        .map((f) => ({
          id: f.id.slice(0, 40),
          market: f.market,
          code: typeof f.code === "string" ? f.code.slice(0, 12) : "",
          name: typeof f.name === "string" ? f.name.slice(0, 20) : "",
          state: isObject(f.state) ? readState(f.state) : emptyState()
        }));
      if (isObject(saved.active)) {
        for (const key of Object.keys(MARKETS)) {
          const id = saved.active[key];
          if (favorites.some((f) => f.id === id && f.market === key)) activeFav[key] = id;
        }
      }
    } catch {
      // 読めないお気に入りは無視して、空の一覧で始める
    }
  }

  function activeFavorite() {
    return favorites.find((f) => f.id === activeFav[market]) || null;
  }

  function currentState() {
    const fav = activeFavorite();
    return fav ? fav.state : states[market];
  }

  // 画面の入力を、選んでいるお気に入り（なければ市場ごとの入力）へ書き戻す
  function storeCurrent() {
    const fav = activeFavorite();
    if (fav) fav.state = snapshot();
    else states[market] = snapshot();
  }

  function refreshAfterRestore() {
    setCostPanel(breakeven.cost.value.trim() !== "");
    normalizeRateInput();
    updateHolding();
    updateBreakeven();
    update();
    renderFavorites();
    save();
  }

  function selectFavorite(id) {
    storeCurrent();
    activeFav[market] = activeFav[market] === id ? null : id;
    restore(currentState());
    refreshAfterRestore();
  }

  const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

  function renderFavorites() {
    // 計算画面のチップ（今の市場の銘柄だけ）
    const chips = get("fav-chips");
    chips.replaceChildren();
    const inMarket = favorites.filter((f) => f.market === market);
    for (const fav of inMarket) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "fav-chip";
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", String(activeFav[market] === fav.id));
      const code = document.createElement("span");
      code.className = "fav-chip-code";
      code.textContent = fav.code;
      const name = document.createElement("span");
      name.className = "fav-chip-name";
      name.textContent = fav.name || fav.code;
      chip.append(code, name);
      attachLongPress(chip, () => openSheet(fav.id), () => selectFavorite(fav.id));
      chips.append(chip);
    }
    const add = get("fav-add");
    add.classList.toggle("is-wide", inMarket.length === 0);
    add.innerHTML = inMarket.length ? '<span class="fav-add-icon" aria-hidden="true">+</span>' : "＋ お気に入りに追加";
    chips.hidden = inMarket.length === 0;
    updateChipFade();

    // 並べ替え・編集の一覧（今の市場の銘柄だけ）
    get("favorites-title").textContent = `お気に入りの編集（${MARKET_NAMES[market]}）`;
    const list = get("fav-list");
    list.replaceChildren();
    for (const fav of inMarket) {
      const row = document.createElement("li");
      row.className = "fav-row";
      row.dataset.id = fav.id;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "fav-handle";
      handle.setAttribute("aria-label", `${fav.name || fav.code}を並べ替え（上下キーで移動）`);
      handle.innerHTML = svg("M5 9h14M5 15h14");
      attachDrag(handle, row);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "fav-row-open";
      const text = document.createElement("span");
      text.className = "fav-row-text";
      const line = document.createElement("span");
      line.className = "fav-row-line";
      const code = document.createElement("span");
      code.className = "fav-row-code";
      code.textContent = fav.code;
      const name = document.createElement("span");
      name.className = "fav-row-name";
      name.textContent = fav.name || fav.code;
      line.append(code, name);
      text.append(line);
      open.append(text);
      open.insertAdjacentHTML("beforeend", svg("M9 6l6 6-6 6"));
      open.setAttribute("aria-label", `${fav.name || fav.code}を編集`);
      open.addEventListener("click", () => openSheet(fav.id));
      row.append(handle, open);
      list.append(row);
    }
    get("fav-empty").hidden = inMarket.length > 0;
  }

  // 短く押すと選択、長押しで編集。長押しのあとに続く click は選択にしない
  function attachLongPress(element, onLong, onTap) {
    let timer = null;
    let longFired = false;
    let startX = 0;
    let startY = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      longFired = false;
      startX = event.clientX;
      startY = event.clientY;
      cancel();
      timer = setTimeout(() => { longFired = true; timer = null; onLong(); }, 500);
    });
    element.addEventListener("pointermove", (event) => {
      if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) element.addEventListener(type, cancel);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    element.addEventListener("click", (event) => {
      if (longFired) {
        longFired = false;
        event.preventDefault();
        return;
      }
      onTap();
    });
  }

  // ---- 並べ替え: 「≡」をつかんで上下に動かす。キーボードは上下キー ----
  function applyMarketOrder(order) {
    // 今の市場の銘柄が並んでいた位置に、新しい順番で入れ直す
    const queue = order.map((id) => favorites.find((f) => f.id === id));
    favorites = favorites.map((f) => (f.market === market ? queue.shift() : f));
  }

  function moveFavorite(id, delta) {
    const order = favorites.filter((f) => f.market === market).map((f) => f.id);
    const index = order.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return false;
    order.splice(index, 1);
    order.splice(target, 0, id);
    applyMarketOrder(order);
    return true;
  }

  function attachDrag(handle, row) {
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (!moveFavorite(row.dataset.id, event.key === "ArrowUp" ? -1 : 1)) return;
      save();
      renderFavorites();
      get("fav-list").querySelector(`[data-id="${CSS.escape(row.dataset.id)}"] .fav-handle`).focus();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const list = get("fav-list");
      let lastY = event.clientY;
      let offset = 0;
      row.classList.add("is-dragging");
      const onMove = (moveEvent) => {
        offset += moveEvent.clientY - lastY;
        lastY = moveEvent.clientY;
        // 指が隣の行の真ん中を越えたら入れ替え、ずれた分だけ持ち上げ位置を補正する
        const prev = row.previousElementSibling;
        const next = row.nextElementSibling;
        if (next && offset > next.offsetHeight / 2) {
          list.insertBefore(next, row);
          offset -= next.offsetHeight;
        } else if (prev && offset < -prev.offsetHeight / 2) {
          list.insertBefore(row, prev);
          offset += prev.offsetHeight;
        }
        row.style.transform = `translateY(${offset}px)`;
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        row.classList.remove("is-dragging");
        row.style.transform = "";
        applyMarketOrder([...list.children].map((item) => item.dataset.id));
        save();
        renderFavorites();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    });
  }

  // ---- 追加・編集シート ----
  function applySheetMarket() {
    for (const button of document.querySelectorAll("[data-fav-market]")) {
      button.setAttribute("aria-pressed", String(button.dataset.favMarket === sheetMarket));
    }
    get("fav-code-label").textContent = FAV_CODE_RULES[sheetMarket].label;
    get("fav-code").inputMode = sheetMarket === "jp" ? "text" : "text";
    get("fav-code").placeholder = sheetMarket === "jp" ? "7203" : "INTC";
  }

  function showSheet(open) {
    const sheet = get("fav-sheet");
    if (sheet.hidden === !open) return;
    sheet.hidden = !open;
    document.body.classList.toggle("has-sheet", open);
    if (open) {
      // 入力欄にフォーカスするとキーボードが出てシートが押し上げられるので、見出しに置く
      get("fav-sheet-title").focus({ preventScroll: true });
    } else if (sheetReturnFocus && document.contains(sheetReturnFocus)) {
      sheetReturnFocus.focus({ preventScroll: true });
    }
  }

  function openSheet(id) {
    sheetReturnFocus = document.activeElement;
    sheetFavId = id;
    const fav = favorites.find((f) => f.id === id);
    sheetMarket = fav ? fav.market : market;
    get("fav-sheet-title").textContent = fav ? `${fav.name || fav.code}を編集` : "お気に入りに追加";
    get("fav-code").value = fav ? fav.code : "";
    get("fav-name").value = fav ? fav.name : "";
    get("fav-error").textContent = "";
    get("fav-code").setAttribute("aria-invalid", "false");
    get("fav-delete").hidden = !fav;
    applySheetMarket();
    history.pushState({ view: currentView === "main" ? undefined : currentView, sheet: true }, "");
    showSheet(true);
  }

  function closeSheet() {
    if (history.state && history.state.sheet) history.back();
    else showSheet(false);
  }

  for (const button of document.querySelectorAll("[data-fav-market]")) {
    button.addEventListener("click", () => {
      sheetMarket = button.dataset.favMarket;
      applySheetMarket();
    });
  }
  for (const closer of document.querySelectorAll("[data-sheet-close]")) closer.addEventListener("click", closeSheet);
  get("fav-sheet").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });
  get("fav-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) get("fav-save").click();
  });
  get("fav-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) get("fav-name").focus();
  });

  get("fav-save").addEventListener("click", () => {
    const code = get("fav-code").value.normalize("NFKC").trim().toUpperCase();
    const name = get("fav-name").value.normalize("NFKC").trim();
    const rule = FAV_CODE_RULES[sheetMarket];
    let error = "";
    if (!code) error = `${rule.label}を入れてください。`;
    else if (!rule.pattern.test(code)) error = `${rule.label}は${rule.example}で入れてください。`;
    else if (favorites.some((f) => f.market === sheetMarket && f.code === code && f.id !== sheetFavId)) error = "この銘柄はもうお気に入りにあります。";
    get("fav-error").textContent = error;
    get("fav-code").setAttribute("aria-invalid", String(Boolean(error)));
    if (error) {
      get("fav-code").focus();
      return;
    }
    storeCurrent();
    const existing = favorites.find((f) => f.id === sheetFavId);
    if (existing) {
      if (existing.market !== sheetMarket && activeFav[existing.market] === existing.id) {
        // 市場を変えたら、元の市場では選択を外す
        activeFav[existing.market] = null;
      }
      existing.code = code;
      existing.name = name;
      existing.market = sheetMarket;
    } else {
      // 追加するときは、今その市場で入れている値を引き継いで、そのまま選んだ状態にする
      const fav = {
        id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        market: sheetMarket,
        code,
        name,
        state: sheetMarket === market ? snapshot() : emptyState()
      };
      favorites.push(fav);
      activeFav[sheetMarket] = fav.id;
    }
    restore(currentState());
    closeSheet();
    refreshAfterRestore();
  });

  get("fav-delete").addEventListener("click", () => {
    const fav = favorites.find((f) => f.id === sheetFavId);
    if (!fav) return;
    if (!window.confirm(`${fav.name || fav.code}をお気に入りから削除しますか？保存していた入力も消えます。`)) return;
    storeCurrent();
    favorites = favorites.filter((f) => f.id !== fav.id);
    if (activeFav[fav.market] === fav.id) activeFav[fav.market] = null;
    restore(currentState());
    closeSheet();
    refreshAfterRestore();
  });

  get("fav-list-add").addEventListener("click", () => openSheet(null));
  get("fav-add").addEventListener("click", () => openSheet(null));

  // チップが＋ボタンの手前で途切れるときは、右端をふわっと透かして続きがあることを見せる
  function updateChipFade() {
    const chips = get("fav-chips");
    const more = chips.scrollWidth - chips.clientWidth - chips.scrollLeft > 1;
    chips.classList.toggle("is-fading", more);
    chips.classList.toggle("is-fading-left", chips.scrollLeft > 1);
  }
  get("fav-chips").addEventListener("scroll", updateChipFade, { passive: true });
  window.addEventListener("resize", updateChipFade);

  // ---- 上下ボタンの長押し: 押し続けると連打と同じように増減し、だんだん速くなる ----
  function attachHoldRepeat(button) {
    let timer = null;
    let repeated = false;
    let synthetic = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    const tick = (delay) => {
      if (button.disabled) return stop();
      repeated = true;
      synthetic = true;
      button.click();
      synthetic = false;
      // だんだん速くするが、約90ミリ秒（1秒に11回ほど）で一定にする
      timer = setTimeout(() => tick(Math.max(90, delay * 0.85)), delay);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || button.disabled) return;
      repeated = false;
      stop();
      timer = setTimeout(() => tick(160), 400);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, stop);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    // 長押しで連続増減したあとの、指を離したときの click は数えない
    button.addEventListener("click", (event) => {
      if (synthetic) return;
      if (repeated) {
        repeated = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }, true);
  }
  for (const id of ["rate-up", "rate-down", "rate-whole-up", "rate-whole-down", "price-up", "price-down", "price-fine-up", "price-fine-down"]) {
    attachHoldRepeat(get(id));
  }
  loadSettings();
  account = settings.account;
  applySettings();
  if (history.state && (history.state.view || history.state.sheet)) history.replaceState(null, "");

  load();
  applyMarket();
  renderFavorites();
  setCostPanel(breakeven.cost.value.trim() !== "");
  normalizeRateInput();
  updateHolding();
  updateBreakeven();
  update();
  save();
})();
