import type { PageProps } from '../App';
import { api, run } from '../api';
import { EmptyState, JobCard, PageHeader } from '../components/Common';

export function Activity({ state }: PageProps) {
  return (
    <div className="page">
      <PageHeader title="Activity" subtitle="Backups, restores, recoveries and erases from this session, with their logs.">
        <button className="btn" disabled={!state.jobs.some((j) => j.status !== 'running')} onClick={() => run(api.clearJobs())}>
          Clear finished
        </button>
        <button className="btn" onClick={() => run(api.openLogs())}>
          Open log file
        </button>
      </PageHeader>
      {state.jobs.length === 0 ? (
        <EmptyState icon="activity" title="Nothing has run yet">
          Start a backup, restore, recovery or erase and its progress shows here.
        </EmptyState>
      ) : (
        <div className="job-list">
          {state.jobs.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}
