import { html } from "@mariozechner/mini-lit";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { Chart, type ChartConfiguration, registerables } from "chart.js";
import type { PropertyValues } from "lit";
import { getSitegeistStorage } from "../storage/app-storage.js";

// Register Chart.js components
Chart.register(...registerables);

export class CostsTab extends SettingsTab {
	label = "Costs";
	private totalCost = 0;
	private monthCost = 0;
	private weekCost = 0;
	private todayCost = 0;
	private loading = true;
	private lineChart?: Chart;
	private providerChart?: Chart;
	private byProvider: Record<string, number> = {};
	private byModel: Record<string, number> = {};

	getTabName(): string {
		return this.label;
	}

	async connectedCallback() {
		super.connectedCallback();
		await this.loadCosts();
	}

	protected updated(_changedProperties: PropertyValues): void {
		super.updated?.(_changedProperties);
		// Render charts after DOM update
		if (!this.lineChart && !this.loading) {
			this.renderCharts();
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		// Clean up charts
		if (this.lineChart) {
			this.lineChart.destroy();
		}
		if (this.providerChart) {
			this.providerChart.destroy();
		}
	}

	async loadCosts() {
		const storage = getSitegeistStorage();

		try {
			// Calculate date ranges
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
			const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

			// Fetch aggregated data
			this.totalCost = await storage.costs.getTotalCost();

			const weekCosts = await storage.costs.getCostsByDateRange(weekAgo, now);
			this.weekCost = weekCosts.reduce((sum, e) => sum + e.total, 0);

			const monthCosts = await storage.costs.getCostsByDateRange(monthAgo, now);
			this.monthCost = monthCosts.reduce((sum, e) => sum + e.total, 0);

			const todayCosts = await storage.costs.getCostsByDateRange(today, now);
			this.todayCost = todayCosts.reduce((sum, e) => sum + e.total, 0);

			// Get provider and model breakdowns
			this.byProvider = await storage.costs.getCostsByProvider();
			this.byModel = await storage.costs.getCostsByModel();
		} catch (err) {
			console.error("Failed to load costs:", err);
		} finally {
			this.loading = false;
			this.requestUpdate();
		}
	}

	async renderCharts() {
		const storage = getSitegeistStorage();

		try {
			// Get daily costs for last 30 days
			const allDays = await storage.costs.getAll();
			const last30Days = allDays.slice(0, 30).reverse(); // Most recent 30, chronological order

			// Line chart: daily costs
			const lineCanvas = this.querySelector("#line-chart") as HTMLCanvasElement | null;
			if (lineCanvas) {
				const lineConfig: ChartConfiguration = {
					type: "line",
					data: {
						labels: last30Days.map((d) => {
							const date = new Date(d.date);
							return `${date.getMonth() + 1}/${date.getDate()}`;
						}),
						datasets: [
							{
								label: "Daily Cost ($)",
								data: last30Days.map((d) => d.total),
								borderColor: "rgb(99, 102, 241)",
								backgroundColor: "rgba(99, 102, 241, 0.1)",
								tension: 0.4,
								fill: true,
							},
						],
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						plugins: {
							legend: { display: false },
						},
						scales: {
							y: {
								beginAtZero: true,
								ticks: {
									callback: (value) => `$${value}`,
								},
							},
						},
					},
				};
				this.lineChart = new Chart(lineCanvas, lineConfig);
			}

			// Doughnut chart: provider breakdown
			const providerCanvas = this.querySelector("#provider-chart") as HTMLCanvasElement | null;
			if (providerCanvas && Object.keys(this.byProvider).length > 0) {
				const providerConfig: ChartConfiguration = {
					type: "doughnut",
					data: {
						labels: Object.keys(this.byProvider),
						datasets: [
							{
								data: Object.values(this.byProvider),
								backgroundColor: [
									"rgb(99, 102, 241)", // indigo
									"rgb(244, 63, 94)", // rose
									"rgb(34, 197, 94)", // green
									"rgb(251, 146, 60)", // orange
									"rgb(168, 85, 247)", // purple
									"rgb(14, 165, 233)", // sky
								],
							},
						],
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						plugins: {
							legend: {
								position: "bottom",
							},
						},
					},
				};
				this.providerChart = new Chart(providerCanvas, providerConfig);
			}
		} catch (err) {
			console.error("Failed to render charts:", err);
		}
	}

	render() {
		if (this.loading) {
			return html`<div class="text-center py-8 text-muted-foreground">Loading...</div>`;
		}

		// Sort models by cost (descending)
		const sortedModels = Object.entries(this.byModel).sort((a, b) => b[1] - a[1]);

		return html`
			<div class="space-y-6">
				<!-- Summary Cards -->
				<div class="grid grid-cols-2 gap-4">
					<div class="p-4 rounded-lg border border-border bg-background">
						<div class="text-sm text-muted-foreground">Total (All Time)</div>
						<div class="text-2xl font-bold text-foreground">$${this.totalCost.toFixed(4)}</div>
					</div>
					<div class="p-4 rounded-lg border border-border bg-background">
						<div class="text-sm text-muted-foreground">This Month</div>
						<div class="text-2xl font-bold text-foreground">$${this.monthCost.toFixed(4)}</div>
					</div>
					<div class="p-4 rounded-lg border border-border bg-background">
						<div class="text-sm text-muted-foreground">This Week</div>
						<div class="text-2xl font-bold text-foreground">$${this.weekCost.toFixed(4)}</div>
					</div>
					<div class="p-4 rounded-lg border border-border bg-background">
						<div class="text-sm text-muted-foreground">Today</div>
						<div class="text-2xl font-bold text-foreground">$${this.todayCost.toFixed(4)}</div>
					</div>
				</div>

				<!-- Line Chart -->
				<div class="p-4 rounded-lg border border-border bg-background">
					<h3 class="text-sm font-medium mb-4">Daily Costs (Last 30 Days)</h3>
					<div style="height: 200px">
						<canvas id="line-chart"></canvas>
					</div>
				</div>

				<!-- Charts Row -->
				<div class="grid grid-cols-2 gap-4">
					<!-- Provider Breakdown -->
					<div class="p-4 rounded-lg border border-border bg-background">
						<h3 class="text-sm font-medium mb-4">By Provider</h3>
						${
							Object.keys(this.byProvider).length > 0
								? html`
										<div style="height: 200px">
											<canvas id="provider-chart"></canvas>
										</div>
									`
								: html`<div class="text-center py-8 text-muted-foreground text-sm">No cost data yet</div>`
						}
					</div>

					<!-- Model Breakdown Table -->
					<div class="p-4 rounded-lg border border-border bg-background">
						<h3 class="text-sm font-medium mb-4">By Model</h3>
						${
							sortedModels.length > 0
								? html`
										<div class="space-y-2 max-h-[200px] overflow-y-auto">
											${sortedModels.map(
												([modelKey, cost]) => html`
													<div class="flex justify-between items-center text-sm">
														<span class="text-foreground truncate" title="${modelKey}">${modelKey}</span>
														<span class="font-semibold text-foreground ml-2">$${cost.toFixed(4)}</span>
													</div>
												`,
											)}
										</div>
									`
								: html`<div class="text-center py-8 text-muted-foreground text-sm">No cost data yet</div>`
						}
					</div>
				</div>

				<!-- Info note -->
				<div class="text-xs text-muted-foreground p-3 rounded-lg border border-border bg-secondary/20">
					<strong>Note:</strong> Costs are tracked independently from sessions. Deleting sessions will not affect cost
					history.
				</div>
			</div>
		`;
	}
}

customElements.define("costs-tab", CostsTab);
