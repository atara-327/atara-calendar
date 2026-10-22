import { DayPlaceholder } from './day/DayPlaceholder';
import { FormHost } from './form/FormHost';
import { UndoNotices } from './form/UndoNotices';
import { MonthView } from './month/MonthView';
import { useRoute } from './navigation';
import { SyncNotices } from './sync/SyncStatus';

export function App() {
  const route = useRoute();
  return (
    <>
      {route.name === 'day' ? <DayPlaceholder date={route.date} /> : <MonthView />}
      <SyncNotices />
      <UndoNotices />
      <FormHost />
    </>
  );
}
