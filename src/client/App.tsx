import { DayPlaceholder } from './day/DayPlaceholder';
import { useRoute } from './navigation';
import { PendingBadge, SyncNotices, SyncOverview } from './sync/SyncStatus';

// 月表示（実装 #7）の本体ができるまでは、月表示の場所に、同期の状態だけを出す。
export function App() {
  const route = useRoute();
  return (
    <>
      {route.name === 'day' ? (
        <DayPlaceholder date={route.date} />
      ) : (
        <>
          <PendingBadge />
          <SyncOverview />
        </>
      )}
      <SyncNotices />
    </>
  );
}
