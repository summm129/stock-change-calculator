(function (root) {
  "use strict";

  function parseNumber(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string") return null;

    var text = raw.normalize("NFKC").replace(/[−–—﹣]/g, "-").trim();
    // Commas are accepted only as thousands separators, so a typo such as
    // "2,43" does not silently become a different price.
    if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(text)) {
      return null;
    }
    var value = Number(text.replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function validateBase(base) {
    if (!isFiniteNumber(base) || base <= 0) {
      throw new RangeError("前日終値は0より大きい有限の数値を入力してください。");
    }
  }

  function calculateFromPercent(base, rate) {
    validateBase(base);
    if (!isFiniteNumber(rate) || rate < -100) {
      throw new RangeError("騰落率は−100%以上の有限の数値を入力してください。");
    }
    var price = base * (1 + rate / 100);
    var delta = price - base;
    if (!Number.isFinite(price) || !Number.isFinite(delta)) {
      throw new RangeError("計算結果が大きすぎます。");
    }
    return { price: price === 0 ? 0 : price, delta: delta === 0 ? 0 : delta };
  }

  function calculateFromPrice(base, price) {
    validateBase(base);
    if (!isFiniteNumber(price) || price < 0) {
      throw new RangeError("株価は0以上の有限の数値を入力してください。");
    }
    var delta = price - base;
    var rate = (delta / base) * 100;
    if (!Number.isFinite(rate) || !Number.isFinite(delta)) {
      throw new RangeError("計算結果が大きすぎます。");
    }
    return { rate: rate === 0 ? 0 : rate, delta: delta === 0 ? 0 : delta };
  }

  function calculateBaselineFromChange(price, change) {
    if (!isFiniteNumber(price) || price < 0) {
      throw new RangeError("現在値は0以上の有限の数値を入力してください。");
    }
    if (!isFiniteNumber(change)) {
      throw new RangeError("前日比の値幅は有限の数値を入力してください。");
    }
    var base = price - change;
    validateBase(base);
    return base;
  }

  function formatNumber(value, maximumFractionDigits) {
    var digits = maximumFractionDigits === undefined ? 6 : maximumFractionDigits;
    if (!isFiniteNumber(value) || !Number.isInteger(digits) || digits < 0 || digits > 20) {
      throw new RangeError("有限の数値と0〜20の表示桁数を指定してください。");
    }
    // Intl preserves a minus sign for values that round to zero. Suppress it
    // so an unchanged or effectively unchanged price is never shown as −0.
    var displayValue = Number(value.toFixed(digits)) === 0 ? 0 : value;
    return new Intl.NumberFormat("ja-JP", {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0
    }).format(displayValue);
  }

  var api = Object.freeze({
    parseNumber: parseNumber,
    calculateFromPercent: calculateFromPercent,
    calculateFromPrice: calculateFromPrice,
    calculateBaselineFromChange: calculateBaselineFromChange,
    formatNumber: formatNumber
  });

  root.StockCalculator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
