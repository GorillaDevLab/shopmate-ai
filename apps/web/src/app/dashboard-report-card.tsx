import type { DashboardInsightResult } from "@shopmate/contracts";

type ReportResult = Extract<DashboardInsightResult, { kind: "report" }>;

export function DashboardReportCard({ result }: { result: ReportResult }) {
  return (
    <section className="dashboard-insight dashboard-report-card">
      <header className="dashboard-insight-header">
        <div>
          <h3>{result.title}</h3>
          <p>{result.summary}</p>
        </div>
        <span>AI 报告</span>
      </header>
      <dl className="dashboard-report-metrics">
        {result.metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
      {result.highlights.length > 0 && (
        <ul className="dashboard-report-highlights">
          {result.highlights.map((highlight) => (
            <li key={highlight}>{highlight}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
