import { PendingBadge, SyncNotices, SyncOverview } from './sync/SyncStatus';

// 月表示・日表示（実装 #7 以降）ができるまでは、同期の状態だけを出す。
export function App() {
  return (
    <>
      <PendingBadge />
      <SyncOverview />
      <SyncNotices />
    </>
  );
}
