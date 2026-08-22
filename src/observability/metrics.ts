export type CounterName =
  | "qw_jobs_enqueued_total"
  | "qw_jobs_completed_total"
  | "qw_retries_total"
  | "qw_dead_total"
  | "qw_jobs_reclaimed_total"
  | "qw_schedule_fires_total"
  | "qw_claims_empty_total";

const COUNTER_HELP: Record<CounterName, string> = {
  qw_jobs_enqueued_total: "Jobs enqueued",
  qw_jobs_completed_total: "Attempts finished by result",
  qw_retries_total: "Attempts scheduled for retry",
  qw_dead_total: "Jobs moved to the dead-letter queue",
  qw_jobs_reclaimed_total: "Jobs reclaimed after a visibility timeout",
  qw_schedule_fires_total: "Recurring schedule fires",
  qw_claims_empty_total: "Claim rounds that found no work",
};

interface Series {
  labels: Array<[string, string]>;
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, { value: number; series: Series }>();
  private histos = new Map<string, { samples: number[]; labelNames: string[]; labelValues: string[] }>();

  inc(name: CounterName, labels: Array<[string, string]> = [], v = 1): void {
    const k = labelKey(labels);
    this.counters.set(`${name}|${k}`, (this.counters.get(`${name}|${k}`) ?? 0) + v);
  }

  setGauge(
    name: string,
    help: string,
    labelNames: string[],
    labelValues: string[],
    value: number,
  ): void {
    const k = `${name}|${labelKey(zip(labelNames, labelValues))}`;
    this.gauges.set(k, { value, series: { labels: zip(labelNames, labelValues) } });
    if (!this.gaugeHelp.has(name)) {
      this.gaugeHelp.set(name, help);
      this.gaugeLabelNames.set(name, labelNames);
    }
  }

  observeDuration(queue: string, type: string, ms: number): void {
    const k = `qw_job_duration_ms|${labelKey([["queue", queue], ["type", type]])}`;
    const entry = this.histos.get(k) ?? {
      samples: [],
      labelNames: ["queue", "type"],
      labelValues: [queue, type],
    };
    if (entry.samples.length < 10_000) entry.samples.push(ms);
    this.histos.set(k, entry);
  }

  resetGauges(prefix: string): void {
    for (const k of [...this.gauges.keys()]) {
      if (k.startsWith(prefix + "|")) this.gauges.delete(k);
    }
  }

  private gaugeHelp = new Map<string, string>();
  private gaugeLabelNames = new Map<string, string[]>();

  render(): string {
    const out: string[] = [];
    for (const [name, help] of Object.entries(COUNTER_HELP)) {
      out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} counter`);
      for (const [k, v] of this.counters) {
        const idx = k.indexOf("|");
        const cname = k.slice(0, idx);
        if (cname !== name) continue;
        out.push(`${name}${labelsSuffix(k.slice(idx + 1))} ${v}`);
      }
    }
    const seenGauges = new Set<string>();
    for (const [k] of this.gauges) seenGauges.add(k.slice(0, k.indexOf("|")));
    for (const name of seenGauges) {
      out.push(`# HELP ${name} ${this.gaugeHelp.get(name) ?? name}`);
      out.push(`# TYPE ${name} gauge`);
      for (const [k, g] of this.gauges) {
        if (k.slice(0, k.indexOf("|")) !== name) continue;
        out.push(`${name}${formatLabels(g.series.labels)} ${g.value}`);
      }
    }
    const histoSeen = new Map<string, string[]>();
    for (const entry of this.histos.values()) {
      histoSeen.set("qw_job_duration_ms", entry.labelNames);
    }
    for (const [name] of histoSeen) {
      out.push(`# HELP ${name}_ms Job duration observations in milliseconds`);
      out.push(`# TYPE ${name}_ms summary`);
      const perSeries = new Map<string, { labels: Array<[string, string]>; samples: number[] }>();
      for (const entry of this.histos.values()) {
        const base = zip(entry.labelNames, entry.labelValues);
        perSeries.set(labelKey(base), {
          labels: base,
          samples: [...(perSeries.get(labelKey(base))?.samples ?? []), ...entry.samples],
        });
      }
      let countTotal = 0;
      for (const { labels, samples } of perSeries.values()) {
        out.push(`${name}_count${formatLabels(labels)} ${samples.length}`);
        countTotal += samples.length;
        if (samples.length === 0) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        for (const q of [0.5, 0.95, 0.99]) {
          const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
          out.push(`${name}_ms${formatLabels([...labels, ["quantile", String(q)]])} ${sorted[i]}`);
        }
      }
      void countTotal;
    }
    return out.join("\n") + "\n";
  }
}

function zip(names: string[], values: string[]): Array<[string, string]> {
  return names.map((n, i) => [n, values[i] ?? ""] as [string, string]);
}

function labelKey(labels: Array<[string, string]>): string {
  return labels.map(([n, v]) => `${n}\u0000${v}`).join("\u0001");
}

function labelsSuffix(key: string): string {
  if (!key) return "";
  const parts = key.split("\u0001").map((p) => p.split("\u0000"));
  return formatLabels(parts.map(([n, v]) => [n ?? "", v ?? ""] as [string, string]));
}

function formatLabels(labels: Array<[string, string]>): string {
  if (labels.length === 0) return "";
  const body = labels
    .map(([n, v]) => `${n}="${escapeLabel(v)}"`)
    .join(",");
  return `{${body}}`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
