import type {
  BrevynOfficeRenderSurface,
  BrevynSpreadsheetChart,
  BrevynSpreadsheetChartSeries,
} from "../office-model/schema";

const CHART_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b", "#0891b2", "#be123c", "#4f46e5"];
export const DEFAULT_CHART_WIDTH = 720;
export const DEFAULT_CHART_HEIGHT = 320;
const HTML_ENGINE = "brevyn-office-chart-html-v1";

export function renderSpreadsheetChart(chart: BrevynSpreadsheetChart): BrevynOfficeRenderSurface {
  const width = DEFAULT_CHART_WIDTH;
  const height = DEFAULT_CHART_HEIGHT;
  const renderable = chart.series.some((series) => series.values.length > 0);
  const warnings: string[] = [];
  const body = renderable ? chartBodyHtml(chart) : emptyChartHtml("暂无可渲染的图表缓存数据");
  if (!renderable) warnings.push("Chart has no cached numeric series values.");

  return {
    id: `${chart.id}:render-main`,
    kind: "html",
    role: "chart",
    width,
    height,
    mediaType: "text/html",
    data: [
      `<div class="brevyn-chart" data-chart-type="${escapeAttr(chart.type)}">`,
      `<div class="brevyn-chart-title">${escapeHtml(chart.title || chart.name)}</div>`,
      `<div class="brevyn-chart-subtitle">${escapeHtml(chartTypeLabel(chart))}${chart.sourceRefs.length > 0 ? ` · ${escapeHtml(chart.sourceRefs.join(", "))}` : ""}</div>`,
      body,
      `</div>`,
    ].join(""),
    engine: HTML_ENGINE,
    warnings,
  };
}

function chartBodyHtml(chart: BrevynSpreadsheetChart): string {
  if (chart.type === "pie" || chart.type === "doughnut") return pieChartHtml(chart);
  if (chart.type === "line" || chart.type === "scatter" || chart.type === "area") return lineChartHtml(chart);
  return chart.type === "bar" && chart.subtype === "bar" ? horizontalBarChartHtml(chart) : barChartHtml(chart);
}

function barChartHtml(chart: BrevynSpreadsheetChart): string {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const categories = mergedChartCategories(series).slice(0, 12);
  const maxValue = Math.max(...series.flatMap((item) => item.values), 1);
  const bars = categories.map((_category, valueIndex) => {
    const segments = series.map((item, seriesIndex) => {
      const value = item.values[valueIndex] || 0;
      const height = Math.max(2, (value / maxValue) * 100);
      return `<div class="brevyn-chart-bar" title="${escapeAttr(`${item.name}: ${value}`)}" style="height:${round(height)}%;background:${CHART_COLORS[seriesIndex % CHART_COLORS.length]}"></div>`;
    }).join("");
    return `<div class="brevyn-chart-bar-group">${segments}</div>`;
  }).join("");
  const labels = categories.map((label) => `<div class="brevyn-chart-axis-label">${escapeHtml(truncateChartLabel(label, 12))}</div>`).join("");
  return [
    `<div class="brevyn-chart-plot brevyn-chart-plot-bars">${bars}</div>`,
    `<div class="brevyn-chart-axis">${labels}</div>`,
    chartLegendHtml(series),
  ].join("");
}

function horizontalBarChartHtml(chart: BrevynSpreadsheetChart): string {
  const first = chart.series.find((item) => item.values.length > 0);
  const values = first?.values.slice(0, 12) || [];
  const categories = first?.categories.length ? first.categories : values.map((_value, index) => String(index + 1));
  const maxValue = Math.max(...values, 1);
  const rows = values.map((value, index) => {
    const width = Math.max(2, (value / maxValue) * 100);
    return [
      `<div class="brevyn-chart-hbar-label">${escapeHtml(truncateChartLabel(categories[index] || String(index + 1), 16))}</div>`,
      `<div class="brevyn-chart-hbar-track"><div class="brevyn-chart-hbar-fill" style="width:${round(width)}%;background:${CHART_COLORS[0]}"></div></div>`,
    ].join("");
  }).join("");
  return `<div class="brevyn-chart-plot brevyn-chart-plot-hbars">${rows}</div>`;
}

function lineChartHtml(chart: BrevynSpreadsheetChart): string {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const values = series.flatMap((item) => item.values);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const span = Math.max(1, maxValue - minValue);
  const lines = series.map((item, seriesIndex) => {
    const points = item.values.map((value, index) => {
      const left = item.values.length <= 1 ? 50 : (index / (item.values.length - 1)) * 100;
      const top = 100 - ((value - minValue) / span) * 100;
      return `<span class="brevyn-chart-point" style="left:${round(left)}%;top:${round(top)}%;background:${CHART_COLORS[seriesIndex % CHART_COLORS.length]}" title="${escapeAttr(`${item.name}: ${value}`)}"></span>`;
    }).join("");
    return `<div class="brevyn-chart-line-layer">${points}</div>`;
  }).join("");
  return `<div class="brevyn-chart-plot brevyn-chart-plot-line">${lines}</div>${chartLegendHtml(series)}`;
}

function pieChartHtml(chart: BrevynSpreadsheetChart): string {
  const series = chart.series.find((item) => item.values.length > 0);
  const values = series?.values.slice(0, 10) || [];
  const categories = series?.categories.length ? series.categories : values.map((_value, index) => String(index + 1));
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const gradientParts: string[] = [];
  let cursor = 0;
  values.forEach((value, index) => {
    const start = cursor;
    const end = cursor + (Math.max(0, value) / total) * 100;
    gradientParts.push(`${CHART_COLORS[index % CHART_COLORS.length]} ${round(start)}% ${round(end)}%`);
    cursor = end;
  });
  const legend = values.map((value, index) => (
    `<div class="brevyn-chart-pie-label"><span style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>${escapeHtml(truncateChartLabel(categories[index] || String(index + 1), 22))} · ${Math.round((value / total) * 100)}%</div>`
  )).join("");
  const className = chart.type === "doughnut" ? "brevyn-chart-pie brevyn-chart-doughnut" : "brevyn-chart-pie";
  return `<div class="brevyn-chart-plot brevyn-chart-plot-pie"><div class="${className}" style="background:conic-gradient(${gradientParts.join(",")})"></div><div class="brevyn-chart-pie-legend">${legend}</div></div>`;
}

function emptyChartHtml(label: string): string {
  return `<div class="brevyn-chart-empty">${escapeHtml(label)}</div>`;
}

function chartLegendHtml(series: BrevynSpreadsheetChartSeries[]): string {
  return `<div class="brevyn-chart-legend">${series.slice(0, 4).map((item, index) => (
    `<span><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i>${escapeHtml(truncateChartLabel(item.name || `Series ${index + 1}`, 16))}</span>`
  )).join("")}</div>`;
}

function mergedChartCategories(series: BrevynSpreadsheetChartSeries[]): string[] {
  const longest = series.reduce((best, item) => item.categories.length > best.length ? item.categories : best, [] as string[]);
  if (longest.length > 0) return longest;
  const maxLength = Math.max(...series.map((item) => item.values.length), 0);
  return Array.from({ length: maxLength }, (_value, index) => String(index + 1));
}

function chartTypeLabel(chart: BrevynSpreadsheetChart): string {
  if (chart.type === "bar") return chart.subtype === "bar" ? "条形图" : "柱状图";
  if (chart.type === "line") return "折线图";
  if (chart.type === "pie") return "饼图";
  if (chart.type === "doughnut") return "环形图";
  if (chart.type === "scatter") return "散点图";
  if (chart.type === "area") return "面积图";
  if (chart.type === "radar") return "雷达图";
  if (chart.type === "bubble") return "气泡图";
  if (chart.type === "stock") return "股票图";
  if (chart.type === "surface") return "曲面图";
  if (chart.type === "treemap") return "树状图";
  if (chart.type === "sunburst") return "旭日图";
  if (chart.type === "histogram") return "直方图";
  if (chart.type === "boxWhisker") return "箱线图";
  if (chart.type === "waterfall") return "瀑布图";
  return "图表";
}

function truncateChartLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
