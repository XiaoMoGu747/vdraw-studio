import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui/Modal';

export function ChemReportModal() {
  const report = useAppStore((state) => state.chemReport);
  const setChemReport = useAppStore((state) => state.setChemReport);
  const setSelection = useAppStore((state) => state.setSelection);

  if (!report) return null;

  return (
    <Modal
      title={report.title}
      subtitle={`共 ${report.issues.length} 条提示`}
      onClose={() => setChemReport(null)}
      footer={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setChemReport(null)}>
          关闭
        </button>
      }
    >
      {report.issues.length === 0 ? (
        <div className="report-empty">
          <span className="report-empty__icon">✓</span>
          <p>{report.emptyMessage}</p>
        </div>
      ) : (
        <ul className="report-list">
          {report.issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => {
                  if (issue.objectId) setSelection([issue.objectId]);
                  setChemReport(null);
                }}
              >
                <span className={`report-dot report-dot--${issue.severity}`} />
                <span>{issue.message}</span>
                <span className="report-list__action">定位</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
