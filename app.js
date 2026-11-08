(() => {
  "use strict";

  const { parseNumber, calculateFromPercent, calculateFromPrice, formatNumber } = StockCalculator;
  const STORAGE_KEY = "stock-change-calculator:v2";
  // 見た目の設定は入力値と分けて保存する。index.html の先頭でも同じキーを読んでちらつきを防ぐ。
  const SETTINGS_KEY = "stock-change-calculator:settings";
  // お気に入り銘柄。各銘柄が自分の入力値（前日終値など）を持つ。active は市場ごとに選んでいる銘柄
  const FAVORITES_KEY = "stock-change-calculator:favorites";
  // account は米国株の証券会社と口座。tokutei / nisa は楽天証券（以前の保存値のまま）、moomoo は moomoo証券の特定口座
  const SETTING_VALUES = { theme: ["light", "dark"], layout: ["scroll", "tabs"], account: ["tokutei", "nisa", "moomoo"], keypad: ["standard", "simeji"], fine: ["both", "tick", "ruler"] };
  const ACCOUNT_LABELS = { tokutei: "楽天・特定", nisa: "楽天・NISA", moomoo: "moomoo・特定" };
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
  // moomoo証券・米国株（ベーシックコース、2026-11時点）。税抜0.12%（上限20ドル、0.01ドル未満は0.01ドル）＋消費税10%。
  // NISA は使わない。SEC Fee は引かれない（2026-11-06 の約定明細で確認）
  const MOOMOO_US = { commissionRate: 0.0012, taxRate: 0.1, capCents: 2000 };
  const defaults = { baseline: "", rate: "", price: "" };
  const fields = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.getElementById(key)]));
  const get = (id) => document.getElementById(id);
  // 保有（買値・株数）。損益の表示と、米国株の 03 の買付約定価格に使う
  const hold = { buy: get("hold-buy"), qty: get("hold-qty") };
  const holdInputs = Object.values(hold);
  const breakeven = { cost: get("cost-basis") };
  const breakevenInputs = Object.values(breakeven);
  // 売る: 01 の売値と、02 の目標の率（前日終値か買値から何%で売るか）
  const sell = { price: get("sell-price"), rate: get("target-rate") };
  const sellInputs = Object.values(sell);
  const inputs = [...Object.values(fields), ...holdInputs, ...breakevenInputs, ...sellInputs];
  let storageAvailable = true;
  let market = "jp";
  let rateSign = 1;
  const states = { jp: emptyState(), us: emptyState() };
  const settings = { theme: "light", layout: "scroll", account: "tokutei", keypad: "standard", fine: "both" };
  // 上下ボタンの刻み（Tick）。0=1、1=0.1、2=0.01。画面を開くたびに1から
  const tickIndex = { rate: 0, price: 0, sell: 0, target: 0 };
  const TICK_TEXT = ["1", "0.1", "0.01"];
  let favorites = [];
  const activeFav = { jp: null, us: null };
  let account = "tokutei";
  // 前日終値を自動で入れたときの終値の日付と、取得した時刻。手で打ち直したら空に戻す
  let closeDate = "";
  let closeAt = 0;
  // 「画面の作り: タブ」のとき、買う・売るそれぞれで開いているカード
  const activeTab = { buy: "percent", sell: "sell" };
  // 買う / 売る。銘柄ごとに保存する。保存がなければ、保有の買値があれば売る、なければ買う
  let mode = "buy";
  let targetSign = 1;
  let targetBase = "close";

  function emptyState() {
    // account は米国株の証券会社・口座。空なら設定の初期値を使う
    return { baseline: "", rate: "", price: "", rateSign: 1, holdBuy: "", holdQty: "", costBasis: "", account: "", closeDate: "", closeAt: 0, mode: "", sellPrice: "", targetRate: "", targetSign: 1, targetBase: "close" };
  }

  function snapshot() {
    return {
      baseline: fields.baseline.value,
      rate: fields.rate.value,
      price: fields.price.value,
      rateSign,
      holdBuy: hold.buy.value,
      holdQty: hold.qty.value,
      costBasis: breakeven.cost.value,
      account,
      closeDate,
      closeAt,
      mode,
      sellPrice: sell.price.value,
      targetRate: sell.rate.value,
      targetSign,
      targetBase
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
    account = state.account || settings.account;
    closeDate = state.closeDate;
    closeAt = state.closeAt;
    mode = state.mode || (state.holdBuy.trim() !== "" ? "sell" : "buy");
    sell.price.value = state.sellPrice;
    sell.rate.value = state.targetRate;
    targetSign = state.targetSign;
    targetBase = state.targetBase;
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
    if (SETTING_VALUES.account.includes(saved.account)) state.account = saved.account;
    if (typeof saved.closeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.closeDate)) state.closeDate = saved.closeDate;
    if (Number.isFinite(saved.closeAt) && saved.closeAt > 0) state.closeAt = saved.closeAt;
    if (saved.mode === "buy" || saved.mode === "sell") state.mode = saved.mode;
    if (typeof saved.sellPrice === "string" && saved.sellPrice.length <= 32) state.sellPrice = saved.sellPrice;
    if (typeof saved.targetRate === "string" && saved.targetRate.length <= 32) state.targetRate = saved.targetRate;
    if (saved.targetSign === -1 || saved.targetSign === 1) state.targetSign = saved.targetSign;
    if (saved.targetBase === "close" || saved.targetBase === "buy") state.targetBase = saved.targetBase;
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
    const hasFine = config.fineDigits !== null;
    applyTicks();
    get("qty-up").setAttribute("aria-label", `${qtyUnit()}株増やす`);
    get("qty-down").setAttribute("aria-label", `${qtyUnit()}株減らす`);
    get("breakeven-card").hidden = market !== "us";
    get("tab-breakeven").hidden = market !== "us";
    applyTabs();
    get("price-help").textContent = hasFine
      ? `現在値や目標の株価を入力してください。右の上下ボタンで、選んだ Tick（1・0.1・0.01${config.unit}）ずつ増減できます。`
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

  function normalizeTargetInput() {
    targetSign = normalizeMagnitudeInput(sell.rate, targetSign);
  }

  // 株数の上下ボタンの単位: 日本株は100株（単元）、米国株は1株
  const qtyUnit = () => (market === "us" ? 1 : 100);

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
    const steppingQty = hasQty ? qty : 0;
    get("qty-up").disabled = steppingQty === null || steppingQty < 0 || steppingQty >= 1e9;
    get("qty-down").disabled = steppingQty === null || steppingQty <= 0;
    updateClearButtons();
  }

  // 売値に対する損益。株数がなければ1株として計算する。米国株は選んでいる証券会社・口座の手数料を引く
  function pnlOf(price) {
    const { buy, qty } = holdValues();
    if (buy === null || price === null) return null;
    const shares = qty ?? 1;
    if (market !== "us") return { gain: (price - buy) * shares, rate: (price / buy - 1) * 100, fees: null, qty };
    // 手数料は注文全体の金額で出す（上限が効くため）
    const buyCents = toCents(buy * shares);
    const sellCents = toCents(price * shares);
    const buyFee = account === "nisa" ? 0 : buyFeeCents(buy, shares, buyCents);
    const fees = buyFee + sellFeeCents(sellCents);
    const net = sellCents - buyCents - fees;
    return { gain: net / 100, rate: (net / (buyCents + buyFee)) * 100, fees, qty };
  }

  const sharesLabel = (qty) => `${qty === null ? 1 : formatNumber(qty, 4)}株${market === "us" ? "・手数料引後" : ""}`;

  function gainText(gain) {
    // 米国株は手数料を引いた額なのでセントまで出す
    if (market !== "us") return signedMoney(gain);
    const cents = toCents(gain);
    return `${cents < 0 ? "−" : cents > 0 ? "+" : ""}${centsText(Math.abs(cents))}`;
  }

  function renderFeeNote(note, result) {
    if (!result || result.fees === null) {
      note.replaceChildren();
      return;
    }
    const label = document.createElement("span");
    label.textContent = `うち手数料（${ACCOUNT_LABELS[account]}${result.qty === null ? "・1株" : ""}）`;
    const amount = document.createElement("span");
    amount.textContent = `−${centsText(result.fees)}`;
    note.replaceChildren(label, amount);
  }

  function validBaseline() {
    const value = parseNumber(fields.baseline.value);
    return value !== null && value > 0 && value <= 1e9 ? value : null;
  }

  // 売る: 01 売値 → 損益、02 前日終値（または買値）から % → 売値
  function updateSell() {
    const { buy } = holdValues();
    get("sell-empty").hidden = buy !== null;
    get("sell-body").hidden = buy === null;

    // 01
    const hasPrice = sell.price.value.trim() !== "";
    const price = parseNumber(sell.price.value);
    let priceError = "";
    if (hasPrice && price === null) priceError = "数字で入力してください。";
    else if (hasPrice && price < 0) priceError = `売値は0${unitName()}以上で入力してください。`;
    else if (hasPrice && price > 1e9) priceError = `売値は10億${unitName()}以下で入力してください。`;
    const shownPriceError = document.activeElement === sell.price ? "" : priceError;
    sell.price.setAttribute("aria-invalid", String(Boolean(shownPriceError)));
    get("sell-price-error").textContent = shownPriceError;
    const steppingPrice = hasPrice ? price : 0;
    const canStep = steppingPrice !== null && steppingPrice >= 0 && steppingPrice <= 1e9;
    for (const id of ["sell-up"]) get(id).disabled = !canStep || steppingPrice >= 1e9;
    for (const id of ["sell-down"]) get(id).disabled = !canStep || steppingPrice <= 0;
    const { qty, buy: heldBuy } = holdValues();
    get("set-hold-buy").disabled = heldBuy === null;
    get("sell-label").textContent = `損益（${sharesLabel(qty)}）`;
    const result = hasPrice && !priceError ? pnlOf(price) : null;
    if (result) {
      setDirection(get("sell-panel"), result.gain);
      get("sell-result-value").textContent = gainText(result.gain);
      get("sell-rate").textContent = `${signed(result.rate, 2)}%`;
    } else {
      setDirection(get("sell-panel"), 0);
      get("sell-result-value").textContent = "—";
      get("sell-rate").textContent = "—";
    }
    renderFeeNote(get("sell-note"), result);

    // 02
    const sign = get("target-sign");
    sign.textContent = targetSign < 0 ? "−" : "+";
    sign.setAttribute("aria-label", targetSign < 0 ? "現在マイナス。プラスに切り替え" : "現在プラス。マイナスに切り替え");
    for (const button of document.querySelectorAll("[data-target-base]")) {
      button.setAttribute("aria-pressed", String(button.dataset.targetBase === targetBase));
    }
    const baseName = targetBase === "close" ? "前日終値" : "買値";
    get("target-heading").textContent = `${baseName} → 売値`;
    const hasRate = sell.rate.value.trim() !== "";
    const magnitude = hasRate ? parseNumber(sell.rate.value) : 0;
    let rateError = "";
    if (hasRate && (magnitude === null || magnitude < 0)) rateError = "数字で入力してください。";
    else if (targetSign < 0 && magnitude > 100) rateError = "−100%以上で入力してください。";
    else if (magnitude > 10000) rateError = "10,000%以下で入力してください。";
    const shownRateError = document.activeElement === sell.rate ? "" : rateError;
    sell.rate.setAttribute("aria-invalid", String(Boolean(shownRateError)));
    get("target-rate-error").textContent = shownRateError;
    const limit = targetSign < 0 ? 100 : 10000;
    const canStepRate = magnitude !== null && magnitude >= 0 && magnitude <= limit;
    for (const id of ["target-up"]) get(id).disabled = !canStepRate || magnitude >= limit;
    for (const id of ["target-down"]) get(id).disabled = !canStepRate || magnitude <= 0;
    for (const button of document.querySelectorAll("[data-target-rate]")) {
      button.setAttribute("aria-pressed", String(hasRate && !rateError && Number(button.dataset.targetRate) === magnitude));
    }
    const from = targetBase === "close" ? validBaseline() : buy;
    const fromNote = get("target-from");
    get("target-gain-label").textContent = `実現損益（${sharesLabel(qty)}）`;
    if (from === null) fromNote.textContent = targetBase === "close" ? "「買う」で前日終値を入れると計算します。" : "";
    if (from === null || !hasRate || rateError) {
      setDirection(get("target-panel"), 0);
      get("target-result-value").textContent = "—";
      get("target-gain").textContent = "—";
      if (from !== null) fromNote.textContent = "";
      renderFeeNote(get("target-note"), null);
    } else {
      const rate = targetSign * magnitude;
      const raw = from * (1 + rate / 100);
      // 米国株は1セント、日本株は1円に切り上げる（呼値の刻みは考えない）
      const target = market === "us" ? Math.ceil(raw * 100 - 1e-9) / 100 : Math.ceil(raw - 1e-9);
      // 米国株はセントまで（48.20 のように0も出す）
      get("target-result-value").textContent = market === "us" ? centsText(toCents(target)).slice(1) : formatNumber(target, 0);
      fromNote.textContent = `${baseName} ${money(from)} から ${signed(rate, 2)}%`;
      const pnl = pnlOf(target);
      setDirection(get("target-panel"), pnl ? pnl.gain : 0);
      get("target-gain").textContent = pnl ? gainText(pnl.gain) : "—";
      renderFeeNote(get("target-note"), pnl);
    }
    updateClearButtons();
  }

  // --- 損益分岐点（米国株・楽天証券 / moomoo証券） --------------------------
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

  // moomoo の手数料（買付・売却とも）: 税抜0.12%を1セント未満切り捨て（最低1セント、上限20ドル）、消費税10%も切り捨て。
  // 明細（45.47→0.05、43.67→0.05、91.90→0.11＋税0.01）と一致
  function moomooCommissionCents(amountCents) {
    const base = Math.min(Math.max(1, Math.floor(amountCents * MOOMOO_US.commissionRate + 1e-9)), MOOMOO_US.capCents);
    return base + Math.floor(base * MOOMOO_US.taxRate + 1e-9);
  }

  // 選んでいる証券会社・口座の買付手数料（注文全体、取得単価の訂正なし）
  function buyCommissionCents(amountCents) {
    if (account === "nisa") return 0;
    return account === "moomoo" ? moomooCommissionCents(amountCents) : commissionCents(amountCents);
  }

  // 選んでいる証券会社・口座で売るときに引かれる額（売却手数料＋SEC Fee）
  function sellFeeCents(amountCents) {
    if (account === "moomoo") return moomooCommissionCents(amountCents);
    return (account === "tokutei" ? sellCommissionCents(amountCents) : 0) + secFeeCents(amountCents);
  }

  // 特定口座の買付手数料（注文全体）。取得単価が正しく入っていれば、約定価格との差を使う
  function buyFeeCents(buy, shares, buyCents) {
    const cost = breakeven.cost.value.trim() === "" ? null : parseNumber(breakeven.cost.value);
    if (cost !== null && cost >= buy && cost <= 1e9) return toCents((cost - buy) * shares);
    return buyCommissionCents(buyCents);
  }

  function sellProfitCents(sellCents, costCents) {
    return sellCents - sellFeeCents(sellCents) - costCents;
  }

  // 損益がプラスになる最小の売却価格（セント）。売却価格が上がるほど損益は増えるので二分探索で求める。
  // 手数料に上限があるため、率だけの近似式からは探さない。
  function firstProfitCents(costCents) {
    let low = 1;
    let high = costCents * 2 + 10000;
    while (sellProfitCents(high, costCents) <= 0) high *= 2;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (sellProfitCents(mid, costCents) > 0) high = mid;
      else low = mid + 1;
    }
    return low;
  }

  const BREAKEVEN_CELLS = ["be-profit", "be-fee-total", "be-fee-buy", "be-fee-sell", "be-fee-sec", "be-cost", "be-even"];

  function clearBreakeven() {
    for (const id of BREAKEVEN_CELLS) get(id).textContent = "—";
  }

  const BREAKEVEN_NOTES = {
    rakuten: "楽天証券・米国株。1株あたり・外貨決済の概算。特定口座の手数料は税込0.495%（買付は切り捨て、売却は四捨五入）、上限は税込22ドル。SEC Feeは売却代金×0.0000206ドル、最低0.01ドル。",
    moomoo: "moomoo証券・米国株（ベーシックコース）。1株あたり・外貨決済の概算。手数料は税抜0.12%と消費税10%をそれぞれ1セント未満切り捨て（最低0.01ドル）、上限は税込22ドル。SEC Feeはかからない。"
  };

  function applyAccount() {
    for (const button of document.querySelectorAll("[data-account]")) {
      button.setAttribute("aria-pressed", String(button.dataset.account === account));
    }
    const pick = get("account-pick");
    pick.querySelector(".account-pick-label").textContent = ACCOUNT_LABELS[account];
    pick.setAttribute("aria-label", `証券会社と口座（${ACCOUNT_LABELS[account]}）`);
    get("be-account").textContent = ACCOUNT_LABELS[account];
    get("be-fee-sec-row").hidden = account === "moomoo";
    get("breakeven-note").textContent = BREAKEVEN_NOTES[account === "moomoo" ? "moomoo" : "rakuten"];
  }

  function updateBreakeven() {
    applyAccount();
    const { buy } = holdValues();
    const hasBuy = buy !== null;
    const hasCost = breakeven.cost.value.trim() !== "";
    const cost = parseNumber(breakeven.cost.value);
    get("be-buy-display").textContent = hasBuy ? centsText(toCents(buy)) : "—";
    get("be-buy-sub").textContent = hasBuy ? "「保有」欄に入力された買値を使用" : "「保有」欄に買値を入力すると計算します。";
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
    if (account !== "nisa") {
      // 取得単価があれば、約定価格との差を実際の買付手数料として使う
      const cost = hasCost ? toCents(parseNumber(breakeven.cost.value)) : buyCents + buyCommissionCents(buyCents);
      const buyFee = cost - buyCents;
      const profit = firstProfitCents(cost);
      // moomoo は SEC Fee なし（その行は隠す）
      const secFee = account === "moomoo" ? 0 : secFeeCents(profit);
      const sellFee = sellFeeCents(profit) - secFee;
      set("be-profit", profit);
      set("be-fee-total", buyFee + sellFee + secFee);
      set("be-fee-buy", buyFee);
      set("be-fee-sell", sellFee);
      set("be-fee-sec", secFee);
      set("be-cost", cost);
      // 損益分岐点: 手数料・SEC Feeを差し引いて損益が0以下になる最大の価格（利益が出始める1セント手前）
      set("be-even", profit - 1);
    } else {
      const profit = firstProfitCents(buyCents);
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
    get("rate-down").disabled = !canStepRate || magnitude <= 0;
    const steppingPrice = fields.price.value.trim() === "" ? 0 : values.price;
    const canStepPrice = steppingPrice !== null && steppingPrice >= 0 && steppingPrice <= 1e9;
    for (const id of ["price-up"]) get(id).disabled = !canStepPrice || steppingPrice >= 1e9;
    for (const id of ["price-down"]) get(id).disabled = !canStepPrice || steppingPrice <= 0;
    get("set-baseline-price").disabled = Boolean(errors.baseline);
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
    updateSell();
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
    renderClose();
  }

  for (const field of inputs) {
    const notifyInput = holdInputs.includes(field) ? onHoldInput : breakevenInputs.includes(field) ? onBreakevenInput : sellInputs.includes(field) ? onSellInput : onInput;
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
      if (field === sell.rate) normalizeTargetInput();
      // 率の欄は桁区切りも符号も付けない（符号は左のボタン）
      const rateLike = field === fields.rate || field === sell.rate;
      const value = parseNumber(field.value);
      if (value !== null) {
        // Group the integer part without rounding the user's decimal digits.
        const normalized = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
        const unsigned = normalized.replace(/^[+-]/, "");
        const [integer, fraction] = unsigned.split(".");
        const integerValue = Number(integer || "0");
        const sign = rateLike ? "" : value < 0 || /^-/.test(normalized) ? "−" : "";
        const integerText = formatNumber(Math.abs(integerValue), 0);
        field.value = `${sign}${rateLike ? integerText.replaceAll(",", "") : integerText}${fraction !== undefined ? `.${fraction}` : ""}`;
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
      else if (sellInputs.includes(field)) onSellInput();
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

  // 率の上下: 選んだ Tick（1 / 0.1 / 0.01）ずつ。ルーラーは 0.01 ずつ。小数第三位より下は打ったまま残す
  function stepRate(field, sign, direction, stepHundredths) {
    const text = field.value.trim();
    const magnitude = text === "" ? 0 : parseNumber(text);
    const limit = sign < 0 ? 100 : 10000;
    if (magnitude === null || magnitude < 0 || magnitude > limit) return false;
    const [integer, fraction = ""] = text.split(".");
    const decimalPlaces = Math.max(2, fraction.length);
    // Only the hundredths change; retain the remaining digits without floating-point noise.
    const hundredths = Number(integer || "0") * 100 + Number(fraction.slice(0, 2).padEnd(2, "0")) + direction * stepHundredths;
    if (hundredths < 0) field.value = `0.${"0".repeat(decimalPlaces)}`;
    else if (hundredths >= limit * 100) field.value = `${limit}.${"0".repeat(decimalPlaces)}`;
    else field.value = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}${fraction.slice(2)}`;
    return true;
  }
  // ---- Tick とルーラー ----
  // Tick は 0=1、1=0.1、2=0.01。日本株の株価・売値は1円だけ。設定が「ルーラー」なら上下ボタンは1ずつ
  const isPriceKey = (key) => key === "price" || key === "sell";
  function activeTick(key) {
    if (settings.fine === "ruler") return 0;
    if (isPriceKey(key) && MARKETS[market].fineDigits === null) return 0;
    return tickIndex[key];
  }
  // 1回ぶんの増減。率は 0.01 単位の数、株価は小数の桁数で表す
  function stepBy(key, direction, tick) {
    if (key === "rate") { if (stepRate(fields.rate, rateSign, direction, [100, 10, 1][tick])) onInput(); return; }
    if (key === "target") { if (stepRate(sell.rate, targetSign, direction, [100, 10, 1][tick])) onSellInput(); return; }
    const field = key === "price" ? fields.price : sell.price;
    // 米国株は 0.1 で動かしても $200.10 のようにセントまで見せる
    const minFraction = tick > 0 ? (MARKETS[market].fineDigits ?? 0) : 0;
    stepPrice(direction, tick, field, key === "price" ? onInput : onSellInput, minFraction);
  }
  function applyTicks() {
    const config = MARKETS[market];
    for (const group of document.querySelectorAll("[data-tick-for]")) {
      const key = group.dataset.tickFor;
      const tick = activeTick(key);
      for (const button of group.querySelectorAll("[data-tick]")) button.setAttribute("aria-checked", String(Number(button.dataset.tick) === tick));
      const unit = isPriceKey(key) ? config.unit : "";
      const amount = `${TICK_TEXT[tick]}${unit}`;
      const [up, down] = group.querySelectorAll(".stepper-col button");
      up.setAttribute("aria-label", `${amount}増やす`);
      down.setAttribute("aria-label", `${amount}減らす`);
    }
  }
  for (const group of document.querySelectorAll("[data-tick-for]")) {
    const key = group.dataset.tickFor;
    for (const button of group.querySelectorAll("[data-tick]")) {
      button.addEventListener("click", () => { tickIndex[key] = Number(button.dataset.tick); applyTicks(); });
    }
    const [up, down] = group.querySelectorAll(".stepper-col button");
    up.addEventListener("click", () => stepBy(key, 1, activeTick(key)));
    down.addEventListener("click", () => stepBy(key, -1, activeTick(key)));
  }
  // ルーラー: 8px なぞるごとに最小単位（率 0.01、米株 1セント、日本株 1円）。左へなぞると増える
  const RULER_PX = 8;
  for (const ruler of document.querySelectorAll("[data-ruler]")) {
    const key = ruler.dataset.ruler;
    const marks = ruler.querySelector(".ruler-marks");
    let drag = null;
    let offset = 0;
    ruler.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      try { ruler.setPointerCapture(event.pointerId); } catch { /* 取れなくても動く */ }
      drag = { x: event.clientX, acc: 0 };
      ruler.classList.add("is-dragging");
    });
    ruler.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      drag.x = event.clientX;
      drag.acc += dx;
      offset = ((offset + dx) % 80 + 80) % 80;
      marks.style.transform = `translateX(${offset}px)`;
      const fine = isPriceKey(key) ? (MARKETS[market].fineDigits ?? 0) : 2;
      while (Math.abs(drag.acc) >= RULER_PX) {
        const dir = drag.acc > 0 ? 1 : -1;
        drag.acc -= dir * RULER_PX;
        stepBy(key, -dir, fine);
        try { if (navigator.vibrate) navigator.vibrate(4); } catch { /* 振動なしでも動く */ }
      }
    });
    const end = () => { drag = null; ruler.classList.remove("is-dragging"); };
    ruler.addEventListener("pointerup", end);
    ruler.addEventListener("pointercancel", end);
  }

  // 株価を小数第 digits 位で1つ増減する（0 なら1円/1ドル、2 なら1セント）。
  function stepPrice(direction, digits, field = fields.price, notify = onInput, minFraction = 0) {
    const value = field.value.trim() === "" ? 0 : parseNumber(field.value);
    if (value === null || value < 0 || value > 1e9) return;
    const text = field.value.normalize("NFKC").replace(/[−–—﹣]/g, "-").replaceAll(",", "").trim();
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
    const integerText = document.activeElement === field ? String(integerPart) : formatNumber(integerPart, 0);
    let fractionText = "";
    if (digits === 0) fractionText = !clamped && fraction !== undefined ? `.${fraction}` : "";
    else if (!clamped) fractionText = `.${`${String(bounded % scale).padStart(digits, "0")}${tail}`.padEnd(minFraction, "0")}`;
    field.value = `${integerText}${fractionText}`;
    notify();
  }

  get("set-baseline-price").addEventListener("click", () => {
    if (validation("baseline", parseNumber(fields.baseline.value))) return;
    fields.price.value = fields.baseline.value;
    onInput();
  });

  // 売る 01 の「買値をセット」: 保有の買値をそのまま売値へ
  get("set-hold-buy").addEventListener("click", () => {
    if (holdValues().buy === null) return;
    sell.price.value = hold.buy.value;
    onSellInput();
  });


  // 売るの 02: 符号・よく使う率・前日終値か買値か
  get("target-sign").addEventListener("click", () => {
    targetSign *= -1;
    onSellInput();
  });
  for (const button of document.querySelectorAll("[data-target-rate]")) {
    button.addEventListener("click", () => {
      sell.rate.value = button.dataset.targetRate;
      onSellInput();
    });
  }
  for (const button of document.querySelectorAll("[data-target-base]")) {
    button.addEventListener("click", () => {
      targetBase = button.dataset.targetBase;
      onSellInput();
    });
  }

  // 株数の上下: 日本株は100株、米国株は1株ずつ。0 以下になったら空にする
  for (const [id, direction] of [["qty-up", 1], ["qty-down", -1]]) {
    get(id).addEventListener("click", () => {
      const now = hold.qty.value.trim() === "" ? 0 : parseNumber(hold.qty.value);
      if (now === null || now < 0) return;
      const next = Math.min(1e9, now + direction * qtyUnit());
      hold.qty.value = next > 0 ? formatNumber(next, 4) : "";
      onHoldInput();
    });
  }

  // ---- 買う / 売る ----
  function applyMode() {
    for (const button of document.querySelectorAll("[data-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    get("buy-view").hidden = mode !== "buy";
    get("sell-view").hidden = mode !== "sell";
  }
  // 切り替えたほうの画面を、売るは右から・買うは左から少しすべらせて出す
  function switchMode(next) {
    if (mode === next) return;
    mode = next;
    applyMode();
    const view = get(next === "sell" ? "sell-view" : "buy-view");
    view.classList.remove("is-entering-left", "is-entering-right");
    void view.offsetWidth;
    view.classList.add(next === "sell" ? "is-entering-right" : "is-entering-left");
    save();
  }
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => switchMode(button.dataset.mode));
  }
  for (const view of [get("buy-view"), get("sell-view")]) {
    view.addEventListener("animationend", () => view.classList.remove("is-entering-left", "is-entering-right"));
  }

  // スワイプ: なぞっている間は買う・売るが横に並んで指についてくる。離したら近いほうへ吸い付く
  // （半分より先まで動かすか、素早くはらえば切り替え）。左へなぞると売る、右へなぞると買う。
  // 横に動かす部品（ルーラー・お気に入りの帯・入力欄・上下ボタン・メニュー）から始めたときは動かさない
  const SWIPE_SKIP = ".ruler, .fav-strip, input, textarea, .stepper-grid, .qty-steps, .account-menu, .sheet";
  const SWIPE_GAP = 16;
  const track = get("mode-track");
  // 計算画面のどこから始めてもよい（画面の下の空いているところも）。設定・お気に入り一覧・シートを開いているときは動かさない
  const swipeReady = () => currentView === "main" && get("fav-sheet").hidden;
  let swipe = null;
  const views = { buy: get("buy-view"), sell: get("sell-view") };
  const pageWidth = () => track.getBoundingClientRect().width + SWIPE_GAP;
  const offsetOf = (which) => (which === "sell" ? -pageWidth() : 0);
  function beginSwipe() {
    track.classList.add("is-swiping");
    views.buy.hidden = false;
    views.sell.hidden = false;
    track.style.transition = "none";
    track.style.transform = `translateX(${offsetOf(mode)}px)`;
  }
  function endSwipe(next) {
    track.classList.remove("is-swiping");
    track.style.transition = "";
    track.style.transform = "";
    if (next !== mode) {
      mode = next;
      save();
    }
    applyMode();
  }
  document.addEventListener("touchstart", (event) => {
    if (swipe && swipe.settling) return;
    swipe = null;
    if (!swipeReady() || event.touches.length !== 1 || event.target.closest(SWIPE_SKIP)) return;
    const touch = event.touches[0];
    swipe = { x: touch.clientX, y: touch.clientY, dx: 0, state: "pending", samples: [[touch.clientX, Date.now()]] };
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!swipe || swipe.settling || swipe.state === "vertical") return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipe.x;
    const dy = touch.clientY - swipe.y;
    if (swipe.state === "pending") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) >= Math.abs(dx)) { swipe.state = "vertical"; return; }
      swipe.state = "horizontal";
      swipe.x = touch.clientX;
      beginSwipe();
    }
    event.preventDefault();
    let move = touch.clientX - swipe.x;
    // 端（買うでさらに右、売るでさらに左）はゴムのように少しだけ動く
    if ((mode === "buy" && move > 0) || (mode === "sell" && move < 0)) move *= 0.25;
    swipe.dx = move;
    swipe.samples.push([touch.clientX, Date.now()]);
    if (swipe.samples.length > 5) swipe.samples.shift();
    track.style.transform = `translateX(${offsetOf(mode) + move}px)`;
  }, { passive: false });
  const finishSwipe = () => {
    if (!swipe || swipe.state !== "horizontal" || swipe.settling) { if (swipe && !swipe.settling) swipe = null; return; }
    const [first, last] = [swipe.samples[0], swipe.samples[swipe.samples.length - 1]];
    const velocity = (last[0] - first[0]) / Math.max(1, last[1] - first[1]);
    const width = pageWidth();
    let next = mode;
    if (mode === "buy" && (swipe.dx < -width / 2 || (velocity < -0.4 && swipe.dx < -40))) next = "sell";
    if (mode === "sell" && (swipe.dx > width / 2 || (velocity > 0.4 && swipe.dx > 40))) next = "buy";
    swipe.settling = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { swipe = null; endSwipe(next); return; }
    track.style.transition = "transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1)";
    track.style.transform = `translateX(${offsetOf(next)}px)`;
    // 吸い付いている間にボタンの色も先に切り替える
    for (const button of document.querySelectorAll("[data-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mode === next));
    let done = false;
    const settle = () => { if (done) return; done = true; swipe = null; endSwipe(next); };
    track.addEventListener("transitionend", settle, { once: true });
    setTimeout(settle, 400);
  };
  document.addEventListener("touchend", finishSwipe, { passive: true });
  document.addEventListener("touchcancel", finishSwipe, { passive: true });

  function onHoldInput() {
    updateHolding();
    update();
    updateBreakeven();
    save();
    markHeldChips();
  }

  function onSellInput() {
    normalizeTargetInput();
    updateSell();
    save();
  }

  function onBreakevenInput() {
    updateBreakeven();
    // 取得単価は 01/02 の手数料引後の損益にも使う
    update();
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
    targetSign = 1;
    targetBase = "close";
    sell.price.value = "";
    sell.rate.value = "";
    mode = "buy";
    applyMode();
    account = settings.account;
    hold.buy.value = "";
    hold.qty.value = "";
    updateHolding();
    breakeven.cost.value = "";
    updateBreakeven();
    for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
    onInput();
    markHeldChips();
  }

  get("reset").addEventListener("click", resetInputs);
  get("settings-reset").addEventListener("click", () => {
    resetInputs();
    get("settings-reset").blur();
    get("storage-status").textContent = storageAvailable ? "" : get("storage-status").textContent;
  });

  // ---- 証券会社・口座のメニュー（「楽天・特定 ▾」を押すとすぐ下に出る。保有の見出しと設定画面） ----
  function setAccountMenu(pick, open) {
    pick.setAttribute("aria-expanded", String(open));
    get(pick.getAttribute("aria-controls")).hidden = !open;
  }
  for (const pick of document.querySelectorAll(".account-pick")) {
    pick.addEventListener("click", () => setAccountMenu(pick, pick.getAttribute("aria-expanded") !== "true"));
  }
  // メニューの外を押したとき・Esc で閉じる
  document.addEventListener("pointerdown", (event) => {
    for (const pick of document.querySelectorAll('.account-pick[aria-expanded="true"]')) {
      if (!pick.parentElement.contains(event.target)) setAccountMenu(pick, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const pick of document.querySelectorAll('.account-pick[aria-expanded="true"]')) {
      setAccountMenu(pick, false);
      pick.focus();
    }
  });

  // ---- 保有の証券会社・口座（01〜03 共通、銘柄ごとに保存）と取得単価の訂正欄 ----
  for (const button of document.querySelectorAll("[data-account]")) {
    button.addEventListener("click", () => {
      account = button.dataset.account;
      setAccountMenu(get("account-pick"), false);
      get("account-pick").focus();
      updateBreakeven();
      update();
      save();
    });
  }
  get("cost-toggle").addEventListener("click", () => {
    const open = get("cost-panel").hidden;
    setCostPanel(open);
    if (open) breakeven.cost.focus({ preventScroll: true });
  });

  // ---- タブ表示 ----
  function applyTabs() {
    if (market !== "us" && activeTab.sell === "breakeven") activeTab.sell = "sell";
    const open = new Set(Object.values(activeTab));
    for (const tab of document.querySelectorAll("[data-tab]")) {
      const active = open.has(tab.dataset.tab);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-panel]")) {
      panel.classList.toggle("is-active", open.has(panel.dataset.panel));
    }
  }
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    const group = tab.closest("#sell-view") ? "sell" : "buy";
    tab.addEventListener("click", () => {
      activeTab[group] = tab.dataset.tab;
      applyTabs();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const visible = [...tab.parentElement.querySelectorAll("[data-tab]")].filter((t) => !t.hidden);
      const next = visible[(visible.indexOf(tab) + (event.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length];
      activeTab[group] = next.dataset.tab;
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
    root.dataset.fine = settings.fine;
    applyTicks();
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
    const pick = get("settings-account-pick");
    pick.querySelector(".account-pick-label").textContent = ACCOUNT_LABELS[settings.account];
    pick.setAttribute("aria-label", `新しくお気に入り登録する銘柄の初期値（${ACCOUNT_LABELS[settings.account]}）`);
  }

  for (const control of document.querySelectorAll("[data-setting]")) {
    control.addEventListener("click", () => {
      const key = control.dataset.setting;
      settings[key] = control.dataset.value;
      applySettings();
      saveSettings();
      if (key === "account") {
        setAccountMenu(get("settings-account-pick"), false);
        get("settings-account-pick").focus();
      }
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
    if (!state.sheet) openPendingKabutan();
  });

  // 保存した日本株の銘柄の株探を開く（「株探で取得」を押したのと同じ）
  let pendingKabutan = null;
  function openPendingKabutan() {
    const fav = pendingKabutan;
    pendingKabutan = null;
    if (!fav || !favorites.includes(fav)) return;
    openKabutan(fav);
  }

  // ---- お気に入り銘柄 ----
  const FAV_CODE_RULES = {
    jp: { label: "証券コード", pattern: /^[0-9][0-9A-Z]{3}$/, example: "4桁（例: 7203、130A）" },
    us: { label: "ティッカー", pattern: /^[A-Z][A-Z0-9.\-]{0,9}$/, example: "英字（例: INTC、BRK.B）" }
  };
  const MARKET_NAMES = { jp: "日本株", us: "米国株" };
  let sheetFavId = null;
  let sheetMarket = "jp";
  let codeLetters = false;

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
          name: typeof f.name === "string" ? f.name.slice(0, 60) : "",
          autoName: f.autoName === true,
          autoPrefix: typeof f.autoPrefix === "string" && /^\(\d{1,3}\)$/.test(f.autoPrefix) ? f.autoPrefix : "",
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
    normalizeTargetInput();
    applyMode();
    updateHolding();
    updateBreakeven();
    update();
    renderFavorites();
    save();
    renderClose();
    fetchActiveClose();
  }

  function selectFavorite(id) {
    // 取得に失敗した銘柄をもう一度押したら、選択を外さずに取り直す
    if (activeFav[market] === id && quoteStatus[id] === "error") {
      fetchUsClose(activeFavorite(), true);
      return;
    }
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
      chip.dataset.id = fav.id;
      const code = document.createElement("span");
      code.className = "fav-chip-code";
      code.textContent = fav.code;
      const held = document.createElement("span");
      held.className = "fav-chip-held";
      held.textContent = " ●";
      held.hidden = true;
      const heldText = document.createElement("span");
      heldText.className = "sr-only";
      heldText.textContent = "（保有あり）";
      held.append(heldText);
      code.append(held);
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
    markHeldChips();
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

  // 保有の買値が入っている銘柄のチップに「●」を出す（選んでいる銘柄は画面の入力で判断する）
  function markHeldChips() {
    for (const chip of get("fav-chips").querySelectorAll(".fav-chip")) {
      const fav = favorites.find((f) => f.id === chip.dataset.id);
      if (!fav) continue;
      const buy = activeFav[market] === fav.id ? hold.buy.value : fav.state.holdBuy;
      chip.querySelector(".fav-chip-held").hidden = buy.trim() === "";
    }
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
    // 長押しでメニューが出ると指の追跡が切れるので止める
    handle.addEventListener("contextmenu", (event) => event.preventDefault());
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const list = get("fav-list");
      const pointer = event.pointerId;
      // 行のどこをつかんだか。指の位置からこの分だけ上に行を描く
      const grab = event.clientY - row.getBoundingClientRect().top;
      let shift = 0;
      row.classList.add("is-dragging");
      const middle = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      // 行を並べ替えるとハンドルが DOM の中で動き、ハンドルで受けていた指の動きが途切れることがある。
      // そのため指の動きは window で受ける
      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointer) return;
        moveEvent.preventDefault();
        // 指が隣の行の真ん中を越えたら入れ替える（速く動かしたときは何行でも）
        let next;
        while ((next = row.nextElementSibling) && moveEvent.clientY > middle(next)) list.insertBefore(next, row);
        let prev;
        while ((prev = row.previousElementSibling) && moveEvent.clientY < middle(prev)) list.insertBefore(row, prev);
        const naturalTop = row.getBoundingClientRect().top - shift;
        shift = moveEvent.clientY - grab - naturalTop;
        row.style.transform = `translateY(${shift}px)`;
      };
      const onEnd = (endEvent) => {
        if (endEvent.pointerId !== pointer) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        row.classList.remove("is-dragging");
        row.style.transform = "";
        applyMarketOrder([...list.children].map((item) => item.dataset.id));
        save();
        renderFavorites();
      };
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    });
  }

  // ---- 追加・編集シート ----
  function applySheetMarket() {
    for (const button of document.querySelectorAll("[data-fav-market]")) {
      button.setAttribute("aria-pressed", String(button.dataset.favMarket === sheetMarket));
    }
    get("fav-code-label").textContent = FAV_CODE_RULES[sheetMarket].label;
    // 日本株のコードはほとんど数字なので数字のキーボードから。「ABC」で英字（130A などの A）に切り替える。
    // 英字は email にする。text だと日本語入力で開き、毎回「あA」で英字に切り替えることになる（Galaxy の標準キーボードで確認。Simeji は変わらない）
    const jp = sheetMarket === "jp";
    get("fav-code").inputMode = jp && !codeLetters ? "numeric" : "email";
    get("fav-code").placeholder = jp ? "7203" : "INTC";
    const mode = get("fav-code-mode");
    mode.hidden = !jp;
    mode.textContent = codeLetters ? "123" : "ABC";
    mode.setAttribute("aria-label", codeLetters ? "数字のキーボードにする" : "英字のキーボードにする");
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
    // 前の削除のお知らせがシートの「お気に入りから削除」に重なるので、シートを開いたら消す
    hideToast();
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
    get("fav-duplicate").hidden = !fav;
    codeLetters = false;
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
  // コードは英字を大文字にそろえる（全角も半角に）。打っている途中のカーソル位置は保つ
  get("fav-code").addEventListener("input", (event) => {
    if (event.isComposing) return;
    const input = get("fav-code");
    const fixed = input.value.normalize("NFKC").toUpperCase();
    if (fixed === input.value) return;
    const caret = input.selectionStart;
    input.value = fixed;
    input.setSelectionRange(caret, caret);
  });
  get("fav-code").addEventListener("compositionend", () => get("fav-code").dispatchEvent(new Event("input")));
  get("fav-code-mode").addEventListener("pointerdown", (event) => event.preventDefault());
  get("fav-code-mode").addEventListener("click", () => {
    codeLetters = !codeLetters;
    applySheetMarket();
    // キーボードの種類は、入力欄に入り直したときに切り替わる
    const input = get("fav-code");
    input.blur();
    input.focus();
  });
  get("fav-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) get("fav-name").focus();
  });

  get("fav-save").addEventListener("click", () => {
    const code = get("fav-code").value.normalize("NFKC").trim().toUpperCase();
    let name = get("fav-name").value.normalize("NFKC").trim();
    const editing = favorites.find((f) => f.id === sheetFavId);
    // 編集でコード（か市場）を変えて、表示名は触っていなければ、新しい銘柄の名前を取り直す
    if (editing && (editing.code !== code || editing.market !== sheetMarket) && name === editing.name) name = "";
    // 表示名を空にしたら、終値と一緒に取れた銘柄名を入れる（米国株は GAS、日本株は株探で取得）
    let autoName = name === "";
    let autoPrefix = "";
    const rule = FAV_CODE_RULES[sheetMarket];
    // 同じコードがもうあって表示名が空なら、取れた名前の先頭に「(2)」「(3)」のように空いている番号を付ける
    const sameCode = favorites.filter((f) => f.market === sheetMarket && f.code === code && f.id !== sheetFavId);
    if (!name && sameCode.length) {
      let number = 2;
      while (sameCode.some((f) => (f.name || "").startsWith(`(${number})`) || f.autoPrefix === `(${number})`)) number += 1;
      autoPrefix = `(${number})`;
      // 名前が取れるまではコードに番号を付けて出す
      name = `${autoPrefix}${code}`;
    }
    let error = "";
    if (!code) error = `${rule.label}を入れてください。`;
    else if (!rule.pattern.test(code)) error = `${rule.label}は${rule.example}で入れてください。`;
    // 同じコードでも表示名が違えば別のお気に入りにできる（表示名が空ならコードを表示名として比べる）
    else if (favorites.some((f) => f.market === sheetMarket && f.code === code && (f.name || f.code) === (name || code) && f.id !== sheetFavId)) error = "同じ表示名の銘柄がもうお気に入りにあります。表示名を変えると追加できます。";
    get("fav-error").textContent = error;
    get("fav-code").setAttribute("aria-invalid", String(Boolean(error)));
    if (error) {
      get("fav-code").focus();
      return;
    }
    storeCurrent();
    const existing = favorites.find((f) => f.id === sheetFavId);
    // 新しく追加したときと、コード（か市場）を変えたときは終値と名前を取りに行く。日本株は保存したらそのまま株探を開く
    let fetchFor = null;
    if (existing) {
      if (existing.code !== code || existing.market !== sheetMarket) {
        fetchFor = existing;
        // 前の銘柄の終値は使わない
        const state = activeFavorite() === existing ? null : existing.state;
        if (state) Object.assign(state, { closeDate: "", closeAt: 0 });
        else { closeDate = ""; closeAt = 0; }
        delete quoteStatus[existing.id];
      }
      if (existing.market !== sheetMarket && activeFav[existing.market] === existing.id) {
        // 市場を変えたら、元の市場では選択を外す
        activeFav[existing.market] = null;
      }
      existing.code = code;
      existing.name = name;
      existing.autoName = autoName;
      existing.autoPrefix = autoPrefix;
      existing.market = sheetMarket;
    } else {
      // 追加するときは全部の欄を空にして、そのまま選んだ状態にする（米国株は前日終値だけ自動で入る）
      const fav = {
        id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        market: sheetMarket,
        code,
        name,
        autoName,
        autoPrefix,
        state: emptyState()
      };
      // 新しい銘柄は一番左（先頭）に置く
      favorites.unshift(fav);
      activeFav[sheetMarket] = fav.id;
      fetchFor = fav;
    }
    restore(currentState());
    if (fetchFor && fetchFor.market === "jp") pendingKabutan = fetchFor;
    closeSheet();
    refreshAfterRestore();
    if (fetchFor && fetchFor.market === "us") fetchUsClose(fetchFor, true);
    // シートを閉じる戻る操作が終わってから開く（popstate）。履歴を使わずに閉じたときはここで開く
    if (pendingKabutan && get("fav-sheet").hidden) openPendingKabutan();
  });

  get("fav-delete").addEventListener("click", () => {
    const fav = favorites.find((f) => f.id === sheetFavId);
    if (!fav) return;
    // 確認は出さずにすぐ消して、下のお知らせの「元に戻す」で戻せるようにする
    storeCurrent();
    const index = favorites.indexOf(fav);
    const wasActive = activeFav[fav.market] === fav.id;
    favorites = favorites.filter((f) => f.id !== fav.id);
    if (wasActive) activeFav[fav.market] = null;
    restore(currentState());
    closeSheet();
    refreshAfterRestore();
    showToast(`${fav.name || fav.code}を削除しました`, () => {
      storeCurrent();
      favorites.splice(Math.min(index, favorites.length), 0, fav);
      if (wasActive) activeFav[fav.market] = fav.id;
      restore(currentState());
      refreshAfterRestore();
    });
  });

  // 複製: コード・市場と入力（前日終値・保有・口座・売値など）を全部コピーして、新規と同じく一番左に「(2)」付きで足し、複製したほうを選ぶ
  get("fav-duplicate").addEventListener("click", () => {
    const fav = favorites.find((f) => f.id === sheetFavId);
    if (!fav) return;
    storeCurrent();
    const sameCode = favorites.filter((f) => f.market === fav.market && f.code === fav.code);
    let number = 2;
    while (sameCode.some((f) => (f.name || "").startsWith(`(${number})`) || f.autoPrefix === `(${number})`)) number += 1;
    const prefix = `(${number})`;
    const base = (fav.name || fav.code).replace(/^\(\d{1,3}\)/, "");
    const copy = {
      id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      market: fav.market,
      code: fav.code,
      // 名前がまだ取れていなければ、取れたときに番号を付ける
      name: `${prefix}${fav.autoName ? fav.code : base}`.slice(0, 60),
      autoName: fav.autoName,
      autoPrefix: fav.autoName ? prefix : "",
      state: structuredClone(fav.state)
    };
    const previous = activeFav[fav.market];
    favorites.unshift(copy);
    activeFav[fav.market] = copy.id;
    restore(currentState());
    closeSheet();
    refreshAfterRestore();
    showToast(`${fav.name || fav.code}を複製しました`, () => {
      storeCurrent();
      favorites = favorites.filter((f) => f.id !== copy.id);
      if (activeFav[copy.market] === copy.id) activeFav[copy.market] = previous;
      restore(currentState());
      refreshAfterRestore();
    });
  });

  // ---- 下に出るお知らせ（「元に戻す」つき）。しばらくすると消える ----
  let toastTimer = null;
  let toastUndo = null;
  function hideToast() {
    clearTimeout(toastTimer);
    toastUndo = null;
    get("toast").hidden = true;
  }
  function showToast(text, undo) {
    clearTimeout(toastTimer);
    get("toast-text").textContent = text;
    toastUndo = undo;
    get("toast-undo").hidden = !undo;
    get("toast").hidden = false;
    toastTimer = setTimeout(hideToast, 6000);
  }
  get("toast-undo").addEventListener("click", () => {
    const undo = toastUndo;
    hideToast();
    if (undo) undo();
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
  for (const id of ["rate-up", "rate-down", "price-up", "price-down", "sell-up", "sell-down", "target-up", "target-down", "qty-up", "qty-down"]) {
    attachHoldRepeat(get(id));
  }
  // ---- 終値の自動取得 ----
  // 米国株: 設定用リンク（#gas=…）で覚えた GAS に問い合わせる（GOOGLEFINANCE）。
  // 日本株: 「株探で取得」から戻ったとき、ブックマーク「TS終値」がコピーした「TickShift:JP:コード:終値:日付」を読む。
  const QUOTES_KEY = "stock-change-calculator:quotes";
  const GAS_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const CLIP_PATTERN = /^TickShift:JP:([0-9][0-9A-Z]{3}):(\d+(?:\.\d+)?):(\d{4}-\d{2}-\d{2})(?::([^:\s]{1,300}))?$/;
  // 大引けに、終値が出そろうまでの余裕を足した時刻（現地時間）。これを過ぎたら新しい終値を取りに行く
  const CLOSE_TIMES = { jp: { zone: "Asia/Tokyo", time: "15:40" }, us: { zone: "America/New_York", time: "16:10" } };
  // 株探を開いてからこの時間内に戻ったときだけクリップボードを読む（関係ないときに許可を聞かない）
  const CLIP_WAIT_MS = 10 * 60 * 1000;
  const quotes = { gas: "", lastClip: "", kabutanAt: 0, kabutanCode: "" };
  const quoteStatus = {}; // お気に入りの id → "loading" | "error" | "manual"

  function loadQuotes() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUOTES_KEY));
      if (!isObject(saved)) return;
      if (typeof saved.gas === "string" && GAS_PATTERN.test(saved.gas)) quotes.gas = saved.gas;
      if (typeof saved.lastClip === "string" && saved.lastClip.length <= 400) quotes.lastClip = saved.lastClip;
      if (Number.isFinite(saved.kabutanAt)) quotes.kabutanAt = saved.kabutanAt;
      if (typeof saved.kabutanCode === "string" && FAV_CODE_RULES.jp.pattern.test(saved.kabutanCode)) quotes.kabutanCode = saved.kabutanCode;
    } catch {
      // 読めなければ未設定のまま
    }
  }

  function saveQuotes() {
    try {
      localStorage.setItem(QUOTES_KEY, JSON.stringify(quotes));
    } catch {
      // 保存できないブラウザでは、この画面を開いている間だけ使える
    }
  }

  // その時刻から見て、いちばん新しい「確定した終値」の日付（祝日は考えない。祝日は取り直すだけ）
  function latestCloseKey(mkt, ms) {
    const { zone, time } = CLOSE_TIMES[mkt];
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
    const parts = (t) => Object.fromEntries(format.formatToParts(t).map((p) => [p.type, p.value]));
    let t = ms;
    let p = parts(t);
    if (`${p.hour}:${p.minute}` < time) p = parts(t -= 86400000);
    while (p.weekday === "Sat" || p.weekday === "Sun") p = parts(t -= 86400000);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function closeOf(fav) {
    return activeFavorite() === fav ? { baseline: fields.baseline.value, closeDate, closeAt } : fav.state;
  }

  function kabutanUrl(code) {
    const web = `https://s.kabutan.jp/stocks/${code}/`;
    // Android では Firefox で開く。Firefox の Violentmonkey のスクリプトが、開いた株探のページから終値を読んでコピーする。
    // Samsung Internet は指定しても「アプリで開く」（Samsung と Firefox の2択）を出す。消す方法は見つからなかった（2026-11-04 Galaxy で確認）
    return /Android/i.test(navigator.userAgent)
      ? `intent://s.kabutan.jp/stocks/${code}/#Intent;scheme=https;package=org.mozilla.firefox;S.browser_fallback_url=${encodeURIComponent(web)};end`
      : web;
  }

  function renderClose() {
    const fav = activeFavorite();
    const status = fav ? quoteStatus[fav.id] : "";
    const hasValue = fields.baseline.value.trim() !== "";
    const tag = get("close-tag");
    const note = get("close-note");
    tag.className = "close-tag";
    tag.replaceChildren();
    note.className = "close-note";
    note.textContent = "";
    if (status === "loading") {
      const spin = document.createElement("span");
      spin.className = "close-spin";
      spin.setAttribute("aria-hidden", "true");
      tag.append(spin, "取得中");
      note.textContent = "終値を取得中...";
    } else if (status === "error") {
      tag.classList.add("is-error");
      tag.textContent = "取得できませんでした";
      note.classList.add("is-error");
      note.textContent = "終値の取得に失敗しました。もう一度タップすると再取得します。";
    } else if (closeDate && hasValue) {
      tag.classList.add("is-ok");
      tag.textContent = `${closeDate.slice(5).replace("-", "/")} 終値`;
      note.textContent = "自動取得されました。手動で値を変更できます。";
    } else if (status === "manual" && hasValue) {
      note.textContent = "手動入力された値です。";
    }
    tag.hidden = tag.childNodes.length === 0;
    // 米国株は取り直すボタン。手で打った値やエラーのあとでも、押せば GAS に問い合わせる
    get("close-refresh").hidden = !(fav && market === "us" && quotes.gas && status !== "loading");
    const link = get("kabutan-link");
    link.hidden = !(fav && market === "jp");
    if (!link.hidden) {
      link.href = kabutanUrl(fav.code);
      link.target = link.href.startsWith("intent:") ? "_self" : "_blank";
    }
  }

  // 表示名が空で登録された銘柄に、取れた銘柄名を入れる。米国株の名前は会社の種類などを省いて短くする
  function applyName(fav, name) {
    if (!fav.autoName || typeof name !== "string") return;
    let text = name.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (fav.market === "us") text = text.replace(/,? (Inc|Corp|Corporation|Co|Ltd|Plc|PLC|Holdings|Group|N\.?V|S\.?A|Class [A-C])\.?$/g, "").replace(/,? (Inc|Corp|Corporation|Co|Ltd|Plc|PLC)\.?$/g, "").trim();
    text = text.slice(0, 60).trim();
    if (!text) return;
    // 同じ銘柄の2つ目以降は「(2)ハイブリッドテクノロジーズ」のように番号を先頭に
    fav.name = `${fav.autoPrefix || ""}${text}`.slice(0, 60);
    fav.autoName = false;
    fav.autoPrefix = "";
    save();
    renderFavorites();
  }

  function applyClose(fav, close, date) {
    const value = formatNumber(close, MARKETS[fav.market].priceDigits);
    delete quoteStatus[fav.id];
    if (activeFavorite() === fav) {
      fields.baseline.value = value;
      closeDate = date;
      closeAt = Date.now();
      update();
      save();
    } else {
      Object.assign(fav.state, { baseline: value, closeDate: date, closeAt: Date.now() });
      save();
    }
    renderClose();
  }

  async function fetchUsClose(fav, force = false) {
    if (!fav || fav.market !== "us" || !quotes.gas || quoteStatus[fav.id] === "loading") return;
    const known = closeOf(fav);
    // 今開いている間に手で打った値は上書きしない。同じ終値の期間のうちは取り直さない
    if (!force && quoteStatus[fav.id] === "manual") return;
    if (!force && !fav.autoName && known.baseline.trim() !== "" && known.closeDate && latestCloseKey("us", known.closeAt) === latestCloseKey("us", Date.now())) return;
    quoteStatus[fav.id] = "loading";
    renderClose();
    try {
      const response = await fetch(`${quotes.gas}?codes=${encodeURIComponent(`US:${fav.code}`)}`);
      const body = await response.json();
      const quote = isObject(body) && isObject(body.quotes) ? body.quotes[`US:${fav.code}`] : null;
      if (!isObject(quote) || !(quote.close > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date)) throw new Error("no quote");
      if (favorites.includes(fav)) {
        applyName(fav, quote.name);
        applyClose(fav, quote.close, quote.date);
      }
    } catch {
      quoteStatus[fav.id] = "error";
      renderClose();
    }
  }

  function fetchActiveClose() {
    const fav = activeFavorite();
    if (fav && fav.market === "us") fetchUsClose(fav);
  }

  async function importClipboard(attempt = 0) {
    if (Date.now() - quotes.kabutanAt > CLIP_WAIT_MS || !navigator.clipboard || !navigator.clipboard.readText) return;
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      // 戻るボタンで戻った直後は、まだ画面にフォーカスがなくて読めないことがあるので、少しずつ待って読み直す
      if (attempt < 6) setTimeout(() => importClipboard(attempt + 1), 400);
      return;
    }
    const match = CLIP_PATTERN.exec(text);
    // 「株探で取得」を押した銘柄のコピーだけ入れる（前に別の銘柄でコピーした値を入れない）
    if (!match || match[1] !== quotes.kabutanCode || text === quotes.lastClip) return;
    // 同じコードのお気に入りが複数あるときは、選んでいる銘柄を優先する
    const sameCode = favorites.filter((f) => f.market === "jp" && f.code === match[1]);
    const fav = sameCode.find((f) => f.id === activeFav.jp) || sameCode[0];
    if (!fav) return;
    quotes.lastClip = text;
    quotes.kabutanAt = 0;
    saveQuotes();
    if (market !== "jp") document.querySelector('[data-market-select="jp"]').click();
    if (activeFav.jp !== fav.id) selectFavorite(fav.id);
    if (match[4]) {
      try {
        applyName(fav, decodeURIComponent(match[4]));
      } catch {
        // 名前が壊れていたら終値だけ入れる
      }
    }
    applyClose(fav, Number(match[2]), match[3]);
  }

  function renderQuotesSettings() {
    get("quotes-us-desc").textContent = quotes.gas ? "設定済み（お気に入りを選ぶと自動で入る）" : "未設定（設定用リンクを開くと使える）";
    get("quotes-us-clear").hidden = !quotes.gas;
  }

  // 設定用リンク: https://…/stock-change-calculator/#gas=<GAS の exec URL>
  function readSetupLink() {
    const match = /^#gas=(.+)$/.exec(location.hash);
    if (!match) return false;
    let url = "";
    try {
      url = decodeURIComponent(match[1]);
    } catch {
      url = "";
    }
    history.replaceState(history.state, "", location.pathname + location.search);
    if (!GAS_PATTERN.test(url)) return false;
    quotes.gas = url;
    saveQuotes();
    return true;
  }

  fields.baseline.addEventListener("input", () => {
    const fav = activeFavorite();
    if (closeDate || (fav && quoteStatus[fav.id] === "error")) {
      closeDate = "";
      closeAt = 0;
      if (fav) quoteStatus[fav.id] = "manual";
      save();
      renderClose();
    }
  });
  get("close-refresh").addEventListener("click", () => fetchUsClose(activeFavorite(), true));
  // 株探を開いた記録。自分で株探を開いたなら、同じ銘柄・同じ日の値でももう一度入れる
  function markKabutan(code) {
    quotes.kabutanAt = Date.now();
    quotes.kabutanCode = code;
    quotes.lastClip = "";
    saveQuotes();
  }
  get("kabutan-link").addEventListener("click", () => markKabutan(activeFavorite() ? activeFavorite().code : ""));

  function openKabutan(fav) {
    markKabutan(fav.code);
    const link = document.createElement("a");
    link.href = kabutanUrl(fav.code);
    link.target = link.href.startsWith("intent:") ? "_self" : "_blank";
    link.rel = "noopener";
    link.click();
  }
  get("quotes-us-clear").addEventListener("click", () => {
    // 確認は出さずに解除して、「元に戻す」で戻せるようにする（消すと設定用リンクを開き直すまで使えないため）
    const gas = quotes.gas;
    quotes.gas = "";
    saveQuotes();
    renderQuotesSettings();
    renderClose();
    showToast("米国株の終値の自動取得を解除しました", () => {
      quotes.gas = gas;
      saveQuotes();
      renderQuotesSettings();
      renderClose();
    });
  });
  // 同じブラウザの別のタブ（TS終値から開いた TickShift など）が入力を書き換えたら、戻ったときに読み直す。
  // 読み直さずに保存すると、古い入力で上書きしてしまう
  let staleStorage = false;
  window.addEventListener("storage", (event) => {
    if ([STORAGE_KEY, FAVORITES_KEY, QUOTES_KEY].includes(event.key)) staleStorage = true;
  });
  // アプリに戻ってきたとき: 株探から戻ったならクリップボードを読み、米国株は新しい終値が出ていれば取り直す
  let returning = false;
  const onReturn = () => {
    if (document.visibilityState !== "visible" || returning) return;
    if (staleStorage) {
      location.reload();
      return;
    }
    returning = true;
    setTimeout(() => {
      returning = false;
      importClipboard();
      fetchActiveClose();
    }, 300);
  };
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("focus", onReturn);

  loadSettings();
  applySettings();
  if (history.state && (history.state.view || history.state.sheet)) history.replaceState(null, "");

  loadQuotes();
  const setUp = readSetupLink();
  load();
  applyMarket();
  renderFavorites();
  setCostPanel(breakeven.cost.value.trim() !== "");
  normalizeRateInput();
  normalizeTargetInput();
  applyMode();
  updateHolding();
  updateBreakeven();
  update();
  save();
  renderQuotesSettings();
  renderClose();
  fetchActiveClose();
  if (setUp) openView("settings");
})();
