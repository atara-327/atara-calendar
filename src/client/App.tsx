import { BottomNotices } from './BottomNotices';
import { DayPlaceholder } from './day/DayPlaceholder';
import { FormHost } from './form/FormHost';
import { MonthView } from './month/MonthView';
import { useRoute } from './navigation';

export function App() {
  const route = useRoute();
  return (
    <>
      {route.name === 'day' ? <DayPlaceholder date={route.date} /> : <MonthView />}
      <BottomNotices />
      <FormHost />
    </>
  );
}
