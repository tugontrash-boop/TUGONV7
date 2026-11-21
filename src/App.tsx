import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header';
import { HouseholdView } from './components/HouseholdView';
import { KagawadDashboard } from './components/KagawadDashboard';
import { CalibrationModal } from './components/CalibrationModal';
import { WasteReport } from './types';
import { soundAlert } from './utils/audioAlarm';
import { useLanguage } from './context/LanguageContext';
import {
  hydratePiEndpointOnBoot,
  fetchUnifiedReports,
  updateUnifiedReportStatus,
  updateUnifiedReport,
  deleteUnifiedReport,
  clearAllUnifiedReports,
  subscribeToBarangayPortalSync,
  UnifiedReportPatchPayload,
} from './utils/piBridge';
import { tryPushReportToLanPi } from './utils/residentStorage';
import { canonicalTicketKey } from './utils/imageCompressor';

function getReportTimestamp(r?: WasteReport): number {
  if (!r) return 0;
  const raw = r.updatedAt || r.resolvedAt || r.cancelledAt || r.dispatchedAt || r.createdAt;
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export default function App() {
  const [currentRole, setCurrentRole] = useState<'resident' | 'kagawad'>(() => {
    try {
      return (
        localStorage.getItem('pulse_kagawad_auth') === 'true' ||
        localStorage.getItem('trash_kagawad_auth') === 'true' ||
        localStorage.getItem('draw_kagawad_auth') === 'true'
      )
        ? 'kagawad'
        : 'resident';
    } catch {
      return 'resident';
    }
  });
  const { language } = useLanguage();
  const [reports, setReports] = useState<WasteReport[]>([]);
  const [activeStorageMode, setActiveStorageMode] = useState<'pi' | 'cloud'>('pi');
  const [, setScreenRefreshKey] = useState(0);

  const fetchSeqRef = useRef(0);
  const pendingOverlayRef = useRef<Map<string, { report: WasteReport; ts: number }>>(new Map());
  const deletedOverlayRef = useRef<Map<string, number>>(new Map());

  const reconcileWithLocalOverlays = useCallback((fetched: WasteReport[]): WasteReport[] => {
    const now = Date.now();
    // Prune expired overlays (after backend reconciliation window)
    for (const [k, entry] of pendingOverlayRef.current.entries()) {
      if (now - entry.ts > 15000) pendingOverlayRef.current.delete(k);
    }
    for (const [k, ts] of deletedOverlayRef.current.entries()) {
      if (now - ts > 20000) deletedOverlayRef.current.delete(k);
    }

    const filtered = fetched.filter((r) => {
      if (deletedOverlayRef.current.has(r.id)) return false;
      const tk = r.ticketNumber ? canonicalTicketKey(r.ticketNumber) : '';
      if (tk && deletedOverlayRef.current.has(tk)) return false;
      return true;
    });

    const mapped = filtered.map((serverItem) => {
      const overlay = pendingOverlayRef.current.get(serverItem.id);
      if (!overlay) return serverItem;
      const serverTs = getReportTimestamp(serverItem);
      const localTs = getReportTimestamp(overlay.report);
      const serverRev = Number(serverItem.portalRevision || 0);
      const localRev = Number(overlay.report.portalRevision || 0);
      if (serverRev >= localRev && serverTs >= localTs) {
        pendingOverlayRef.current.delete(serverItem.id);
        return serverItem;
      }
      return overlay.report;
    });

    return mapped;
  }, []);

  // Fetch authoritative Barangay queue only when viewing Barangay Official Portal
  const fetchReports = useCallback(
    async (force = false) => {
      if (currentRole !== 'kagawad') return;
      const seq = ++fetchSeqRef.current;
      try {
        const { reports: fetched } = await fetchUnifiedReports(language, undefined, { force });
        if (seq !== fetchSeqRef.current) return;
        setReports(reconcileWithLocalOverlays(fetched));
      } catch (e) {
        console.error('Failed to fetch reports:', e);
      }
    },
    [currentRole, language, reconcileWithLocalOverlays]
  );

  // Hydrate server/edge/query-param Raspberry Pi endpoint on initial app load
  useEffect(() => {
    hydratePiEndpointOnBoot().catch(() => {});
  }, []);

  // Real-time WebSocket + SSE + BroadcastChannel + safety polling strictly for Barangay Official Portal
  useEffect(() => {
    if (currentRole !== 'kagawad') return;
    fetchReports(true);

    const unsubscribe = subscribeToBarangayPortalSync(() => {
      fetchReports(true);
    });

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchReports(true);
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);

    const interval = setInterval(() => {
      fetchReports(false);
    }, 2500);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      clearInterval(interval);
    };
  }, [currentRole, fetchReports]);

  // Handle new submission from household
  const handleReportSubmitted = (newReport: WasteReport) => {
    if (newReport.localSyncStatus === 'SENT_TO_PI') {
      setReports((prev) => [newReport, ...prev.filter((r) => r.id !== newReport.id)]);
      tryPushReportToLanPi(newReport).catch(() => null);
    }
    if (newReport.isElderly || newReport.urgency === 'URGENT_ELDERLY') {
      soundAlert.playUrgentAlarm();
    } else {
      soundAlert.playChime();
    }
  };

  // Handle Official status update (Pending / Dispatched / Resolved with proof / Cancelled)
  const handleUpdateReportStatus = async (
    id: string,
    status: 'PENDING' | 'DISPATCHED' | 'RESOLVED' | 'CANCELLED',
    notes?: string,
    proofPhotos?: string[],
    proofKagawadName?: string
  ) => {
    try {
      const defaultOfficialName =
        language === 'tl'
          ? 'Barangay Kagawad at Cavite City Sanitation Crew'
          : 'Barangay Official & Cavite City Sanitation Crew';

      const data = await updateUnifiedReportStatus(id, {
        status,
        lang: language,
        dispatchedKagawad:
          status === 'DISPATCHED' ? proofKagawadName || defaultOfficialName : undefined,
        resolvedBy: proofKagawadName || defaultOfficialName,
        resolutionNotes: status === 'RESOLVED' ? notes : undefined,
        cancellationReason: status === 'CANCELLED' ? notes : undefined,
        proofPhotos: status === 'RESOLVED' ? proofPhotos : undefined,
        proofKagawadName: status === 'RESOLVED' ? proofKagawadName : undefined,
      });
      if (data.success && data.report) {
        pendingOverlayRef.current.set(id, { report: data.report, ts: Date.now() });
        setReports((prev) => prev.map((r) => (r.id === id ? data.report! : r)));
        fetchReports(true);
      }
    } catch (e) {
      console.error('Failed to update status:', e);
    }
  };

  // Handle Official concern edit/assignment across all connected Portal devices
  const handleEditReport = async (
    id: string,
    patch: Omit<UnifiedReportPatchPayload, 'lang'>
  ): Promise<boolean> => {
    try {
      const data = await updateUnifiedReport(id, {
        ...patch,
        lang: language,
      });
      if (data.success && data.report) {
        pendingOverlayRef.current.set(id, { report: data.report, ts: Date.now() });
        setReports((prev) => prev.map((r) => (r.id === id ? data.report! : r)));
        fetchReports(true);
        return true;
      }
    } catch (e) {
      console.error('Failed to edit concern:', e);
    }
    return false;
  };

  // Handle Deletion of Report from Official Queue (Never deletes resident's private phone log)
  const handleDeleteReport = async (id: string) => {
    try {
      const target = reports.find((r) => r.id === id);
      const ok = await deleteUnifiedReport(id);
      if (ok) {
        const now = Date.now();
        deletedOverlayRef.current.set(id, now);
        if (target?.ticketNumber) {
          deletedOverlayRef.current.set(canonicalTicketKey(target.ticketNumber), now);
        }
        pendingOverlayRef.current.delete(id);
        setReports((prev) => prev.filter((r) => r.id !== id));
        fetchReports(true);
      }
    } catch (e) {
      console.error('Failed to delete report:', e);
    }
  };

  const handleClearAllReports = async () => {
    try {
      const ok = await clearAllUnifiedReports();
      if (ok) {
        const now = Date.now();
        for (const r of reports) {
          deletedOverlayRef.current.set(r.id, now);
          if (r.ticketNumber) {
            deletedOverlayRef.current.set(canonicalTicketKey(r.ticketNumber), now);
          }
        }
        pendingOverlayRef.current.clear();
        setReports([]);
      }
    } catch (e) {
      console.error('Failed to clear all reports:', e);
    }
  };

  const handleScreenCalibrate = () => {
    setScreenRefreshKey((k) => k + 1);
  };

  // Pending count excludes auto-purged items from active queue
  const pendingCount = reports.filter((r) => r.status === 'PENDING' && !r.isPurgedFromFeed).length;

  return (
    <div className="adaptive-app-shell bg-slate-50 flex flex-col selection:bg-emerald-500 selection:text-white">
      {/* Top Application Header */}
      <Header
        currentRole={currentRole}
        onRoleChange={setCurrentRole}
        pendingCount={pendingCount}
        onScreenCalibrate={handleScreenCalibrate}
      />

      {/* Adaptive Screen Calibration Modal */}
      <CalibrationModal />

      {/* Main View Body */}
      <main className="flex-1 w-full max-w-full overflow-x-clip pb-16">
        {currentRole === 'resident' ? (
          <HouseholdView
            onReportSubmitted={handleReportSubmitted}
            activeStorageMode={activeStorageMode}
          />
        ) : (
          <KagawadDashboard
            reports={reports}
            onUpdateReportStatus={handleUpdateReportStatus}
            onEditReport={handleEditReport}
            onDeleteReport={handleDeleteReport}
            onClearAllReports={handleClearAllReports}
            activeStorageMode={activeStorageMode}
            onToggleStorageMode={() =>
              setActiveStorageMode(activeStorageMode === 'pi' ? 'cloud' : 'pi')
            }
          />
        )}
      </main>

      {/* Clean Footer (Removed "Serbisyo sa Koleksyon ng Basura") */}
      <footer className="border-t border-slate-200 bg-white py-6 px-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-center sm:text-left">
            <span className="font-extrabold text-slate-800 text-sm">
              T.U.G.O.N.
            </span>
            <p className="text-[11px] text-slate-400">
              {language === 'tl'
                ? 'Barangay 40 (Gumamela) at Barangay 41 (Rosal), Lungsod ng Cavite'
                : 'Barangay 40 (Gumamela) & Barangay 41 (Rosal), Cavite City'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center sm:justify-end gap-2 text-[11px] text-slate-500">
            <span className="text-emerald-700 font-extrabold">
              Barangay 40 (Gumamela) &amp; 41 (Rosal), Cavite City
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
