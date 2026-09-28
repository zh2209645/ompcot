import { describe, expect, it } from "vitest";
import {
  MODEL_CHART_PALETTE,
  renderCostInfobar,
  renderInfobarModels,
  renderInfobarOverview,
  renderInfobarProjects,
  renderInfobarToolCost,
  renderInfobarUsage,
  TOOL_CHART_PALETTE,
} from "./cost-infobar.js";

describe("cost infobar renderers", () => {
  it("renders overview cards", () => {
    const target = document.createElement("div");
    renderInfobarOverview(
      target,
      {
        totalCost: 9,
        sessions: 7,
        messages: 22,
        totalTokens: 3550,
        activeDays: 4,
        currentStreak: 1,
        longestStreak: 3,
        peakHour: "3 PM",
        favoriteModel: "gpt-4.1",
      },
      {
        inputTokens: 2000,
        outputTokens: 1000,
        cacheRead: 400,
        cacheWrite: 150,
        toolCalls: 6,
      },
    );

    expect(target.querySelectorAll(".infobar-stat-card")).toHaveLength(12);
    expect(target.textContent).toContain("Total cost");
    expect(target.textContent).toContain("$9.00");
    expect(target.textContent).not.toContain("Peak hour");
    expect(target.textContent).toContain("Sessions");
    expect(target.textContent).toContain("Messages");
    expect(target.textContent).toContain("Tool Calls");
  });

  it("renders ranked model and project rows plus usage totals", () => {
    const models = document.createElement("div");
    const projects = document.createElement("div");
    const usage = document.createElement("div");
    const toolCost = document.createElement("div");
    const toolCostMeta = document.createElement("span");
    const OriginalChart = window.Chart;

    window.Chart = function MockChart() {
      return {
        destroy() {},
      };
    };

    try {
      renderInfobarModels(
        models,
        [
          { name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 },
          { name: "gpt-4.1-mini", cost: 1.5, count: 1, fraction: 0.2 },
        ],
        {
          sessions: [
            {
              model: "gpt-4.1",
              time: "2026-06-05T10:00:00.000Z",
              totalTokens: 3200,
              inputTokens: 2000,
              outputTokens: 900,
            },
            {
              model: "gpt-4.1-mini",
              time: "2026-06-06T10:00:00.000Z",
              totalTokens: 1200,
              inputTokens: 600,
              outputTokens: 400,
            },
          ],
        },
      );
      renderInfobarProjects(projects, [
        { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
      ]);
      renderInfobarUsage(usage, {
        totalTokens: 3550,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheRead: 400,
        cacheWrite: 150,
        toolCalls: 6,
        tools: [
          { name: "read_file", count: 2, cost: 1.6, fraction: 1 },
          { name: "edit_file", count: 2, cost: 1.4, fraction: 0.875 },
        ],
      });
      renderInfobarToolCost(
        toolCost,
        {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [
            { name: "read_file", count: 2, cost: 1.6, fraction: 1 },
            { name: "edit_file", count: 2, cost: 1.4, fraction: 0.875 },
          ],
        },
        toolCostMeta,
      );

      expect(models.querySelectorAll(".infobar-model-legend-row")).toHaveLength(2);
      expect(projects.querySelector(".infobar-projects-chart")).not.toBeNull();
      expect(usage.textContent).toContain("Total Tokens");
      // Intl compact is locale-dependent — "3.6K" in en-US, "3550" in zh-CN
      // (this machine) — so assert the total rendered, not its spelling.
      expect(usage.textContent).toMatch(/Total Tokens\s+(?:3\.6K|3[,.']?550)/);
      expect(toolCost.textContent).toContain("read_file");
      expect(toolCostMeta.textContent).toContain("2 tracked");
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("uses the same model palette for chart bars and legend dots", () => {
    const models = document.createElement("div");
    const chartCalls = [];
    const OriginalChart = window.Chart;

    window.Chart = function MockChart(_canvas, config) {
      chartCalls.push(config);
      return {
        destroy() {},
      };
    };

    try {
      renderInfobarModels(
        models,
        [
          { name: "claude-sonnet-4-6", cost: 7.5, count: 2, fraction: 1 },
          { name: "claude-opus-4-7", cost: 3.1, count: 1, fraction: 0.4 },
          { name: "claude-opus-4-8", cost: 1.2, count: 1, fraction: 0.16 },
        ],
        {
          sessions: [
            {
              model: "claude-sonnet-4-6",
              time: "2026-06-05T10:00:00.000Z",
              totalTokens: 3200,
              inputTokens: 2000,
              outputTokens: 900,
            },
            {
              model: "claude-opus-4-7",
              time: "2026-06-06T10:00:00.000Z",
              totalTokens: 1200,
              inputTokens: 600,
              outputTokens: 400,
            },
            {
              model: "claude-opus-4-8",
              time: "2026-06-07T10:00:00.000Z",
              totalTokens: 900,
              inputTokens: 500,
              outputTokens: 300,
            },
          ],
        },
      );

      expect(chartCalls).toHaveLength(1);
      const datasets = chartCalls[0].data.datasets;
      // Chart bars and legend dots read the same palette (they used to be a
      // JS list here and a second, drifted copy in cost.css).
      expect(datasets.map((dataset) => dataset.backgroundColor)).toEqual(MODEL_CHART_PALETTE);
      const dots = Array.from(
        models.querySelectorAll(".infobar-model-legend-row .infobar-tool-legend-dot"),
      );
      expect(dots.map((dot) => dot.getAttribute("style"))).toEqual(
        MODEL_CHART_PALETTE.map((color) => `background:${color}`),
      );
      expect(datasets[0].borderRadius({ dataIndex: 0 })).toEqual({
        topLeft: 6,
        topRight: 6,
        bottomLeft: 6,
        bottomRight: 6,
      });
      expect(datasets[1].borderRadius({ dataIndex: 0 })).toBe(0);
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("charts the top three models, one palette colour each", () => {
    const models = document.createElement("div");
    const chartCalls = [];
    const OriginalChart = window.Chart;
    window.Chart = function MockChart(_canvas, config) {
      chartCalls.push(config);
      return { destroy() {} };
    };

    try {
      // The summary caps the list at three (`buildModelSummary`), which is
      // exactly the palette's length — the legend rows and the stacked series
      // stay in step, one colour each.
      renderInfobarModels(
        models,
        ["a", "b", "c", "d"].map((name, index) => ({
          name: `model-${name}`,
          cost: 4 - index,
          count: 1,
          fraction: 0.25 * (4 - index),
        })),
        {
          sessions: ["a", "b", "c", "d"].map((name, index) => ({
            model: `model-${name}`,
            time: `2026-06-0${index + 1}T10:00:00.000Z`,
            totalTokens: 1000,
            inputTokens: 600,
            outputTokens: 400,
          })),
        },
      );

      const colors = chartCalls[0].data.datasets.map((dataset) => dataset.backgroundColor);
      expect(colors).toEqual(MODEL_CHART_PALETTE);
      const dots = Array.from(
        models.querySelectorAll(".infobar-model-legend-row .infobar-tool-legend-dot"),
      );
      expect(dots).toHaveLength(MODEL_CHART_PALETTE.length);
      expect(dots.map((dot) => dot.getAttribute("style"))).toEqual(
        MODEL_CHART_PALETTE.map((color) => `background:${color}`),
      );
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("uses the same tool palette for the project ring and its legend dots", () => {
    const projects = document.createElement("div");
    const chartCalls = [];
    const OriginalChart = window.Chart;
    window.Chart = function MockChart(_canvas, config) {
      chartCalls.push(config);
      return { destroy() {} };
    };

    try {
      renderInfobarProjects(
        projects,
        ["one", "two", "three", "four", "five", "six", "seven"].map((name, index) => ({
          name,
          path: `/work/${name}`,
          cost: 7 - index,
          sessions: 1,
          fraction: (7 - index) / 28,
        })),
      );

      const colors = chartCalls[0].data.datasets[0].backgroundColor;
      // The ring (and its legend) shows the top six; the palette wraps inside
      // that list rather than running out.
      expect(colors).toEqual(TOOL_CHART_PALETTE);
      const dots = Array.from(
        projects.querySelectorAll(".infobar-tool-legend-row .infobar-tool-legend-dot"),
      );
      expect(dots.map((dot) => dot.getAttribute("style"))).toEqual(
        colors.map((color) => `background:${color}`),
      );
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("renders the single-page infobar sections including sessions", () => {
    const section = document.createElement("section");
    section.innerHTML = `
      <span id="infobar-page-title"></span>
      <div class="infobar-tabs">
        <a class="infobar-tab" href="#usage-overview">Overview</a>
        <a class="infobar-tab" href="#usage-models">Models</a>
        <a class="infobar-tab" href="#usage-tool-cost">Tool Cost</a>
        <a class="infobar-tab" href="#usage-projects">Projects</a>
        <a class="infobar-tab" href="#usage-sessions">Sessions</a>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="overview">
        <div id="infobar-overview-grid"></div>
        <div id="infobar-activity-panel"></div>
        <div id="infobar-overview-note"></div>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="tool-cost">
        <div id="infobar-tool-cost-panel"></div>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="models"><div id="infobar-models-list"></div></div>
      <div class="infobar-panel is-active" data-infobar-panel="projects"><div id="infobar-projects-list"></div></div>
      <div class="infobar-panel is-active" data-infobar-panel="sessions"><div id="infobar-sessions-panel"></div></div>
      <span id="infobar-range-meta"></span>
    `;

    renderCostInfobar(section, {
      range: {
        range: "30d",
        scope: "all",
        from: "2026-05-11T00:00:00.000Z",
        to: "2026-06-06T00:00:00.000Z",
      },
      series: [
        { bucket: "2026-06-05", cost: 2.4, tokens: 1000 },
        { bucket: "2026-06-06", cost: 5.1, tokens: 3000 },
      ],
      sessions: [
        {
          title: "Session 1",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-05-18T10:00:00.000Z",
          totalCost: 1.2,
          totalTokens: 900,
          toolCalls: 1,
          userMessages: 1,
          assistantMessages: 1,
        },
        {
          title: "Session 2",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-06-06T10:00:00.000Z",
          totalCost: 4.2,
          totalTokens: 3200,
          toolCalls: 6,
          userMessages: 2,
          assistantMessages: 2,
        },
        {
          title: "Session 3",
          workspace: "/work/pi-beta",
          model: "gpt-4.1-mini",
          time: "2026-06-05T08:30:00.000Z",
          totalCost: 2.4,
          totalTokens: 1400,
          toolCalls: 3,
          userMessages: 2,
          assistantMessages: 2,
        },
      ],
      summary: {
        totalTokens: 5500,
      },
      infobar: {
        overview: {
          totalCost: 9,
          sessionCount: 7,
          messageCount: 22,
          daysActive: 4,
        },
        models: [{ name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 }],
        projects: [
          { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
        ],
        usage: {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [{ name: "read_file", count: 2, cost: 1.6, fraction: 1 }],
        },
      },
    });

    expect(section.querySelectorAll("#infobar-overview-grid .infobar-stat-card")).toHaveLength(12);
    expect(section.querySelector("#infobar-overview-grid").textContent).toContain("Total cost");
    expect(section.querySelector("#infobar-overview-grid").textContent).toContain("$9.00");
    expect(section.querySelector("#infobar-overview-grid").textContent).not.toContain("Peak hour");
    expect(
      section.querySelector("#infobar-activity-panel").querySelectorAll(".infobar-activity-cell")
        .length,
    ).toBeGreaterThan(0);
    expect(section.querySelector("#infobar-overview-note").textContent).toContain("War and Peace");
    expect(section.querySelector("#infobar-models-list").textContent).toContain("gpt-4.1");
    expect(section.querySelector("#infobar-tool-cost-panel").textContent).toContain("read_file");
    expect(section.querySelector("#infobar-sessions-panel").textContent).toContain("Session 1");
  });
});
